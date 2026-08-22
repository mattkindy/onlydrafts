/**
 * Can we order kickers better than the room does?
 *
 * A kicker scores what his offence hands him. A side that moves the
 * ball and then stalls kicks all afternoon; one that scores
 * touchdowns kicks extra points; one that goes nowhere does neither.
 * So this asks whether last season's kicking, his side's pace and how
 * often it turned a trip inside the twenty into a touchdown beat where
 * he is drafted.
 *
 * Run: npx tsx scripts/kickerEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { spearman } from "../src/backtest/metrics.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import { loadSleeperAdp } from "../src/data/adp.js";
import { loadWeeklyRosters } from "../src/data/nflverse.js";
import { normalizeName } from "../src/data/names.js";

const SEASONS = [2021, 2022, 2023, 2024, 2025];
const TEST = [2023, 2024, 2025];
const RAW = join(import.meta.dirname, "..", "data", "raw");

/** the usual kicking rules: by the yard, a point a conversion */
const scored = (r: Record<string, string | undefined>) => {
  const n = (key: string) => Number(r[key] ?? 0) || 0;

  return n("fg_made_distance") * 0.1 + n("pat_made") -
    3 * n("fg_missed_0_19") - 2 * n("fg_missed_20_29") -
    2 * n("fg_missed_30_39") - n("fg_missed_40_49") - n("fg_missed_50_59") -
    n("pat_missed");
};

interface Kicker {
  id: string;
  name: string;
  team: string;
  games: number;
  points: number;
  /** what he was given and what he did with it */
  attempts: number;
  made: number;
  longAttempts: number;
  longMade: number;
  madeYards: number;
  extraPoints: number;
  clutch: number;
}

async function kickersIn(season: number): Promise<Map<string, Kicker>> {
  const out = new Map<string, Kicker>();
  const rows = parseCsv(
    await readFile(join(RAW, `stats_player_week_${season}.csv`), "utf8")
      .catch(() => ""),
  );

  for (const r of rows) {
    if (r["position"] !== "K" || Number(r["week"]) > 18) {
      continue;
    }

    const id = r["player_id"] ?? "";
    const n = (key: string) => Number(r[key] ?? 0) || 0;
    const his = out.get(id) ?? {
      id, name: r["player_display_name"] ?? id, team: r["team"] ?? "",
      games: 0, points: 0, attempts: 0, made: 0, longAttempts: 0,
      longMade: 0, madeYards: 0, extraPoints: 0, clutch: 0,
    };
    his.games++;
    his.team = r["team"] ?? his.team;
    his.points += scored(r);
    his.attempts += n("fg_att");
    his.made += n("fg_made");
    his.longAttempts += n("fg_made_50_59") + n("fg_missed_50_59") +
      n("fg_made_60_") + n("fg_missed_60_");
    his.longMade += n("fg_made_50_59") + n("fg_made_60_");
    his.madeYards += n("fg_made_distance");
    his.extraPoints += n("pat_att");
    // kicks that decided a game, which is a leg the staff trusts
    his.clutch += n("gwfg_att");
    out.set(id, his);
  }

  return out;
}

/** what each offence did: how much it played, and what it did inside the twenty */
async function offences(season: number): Promise<Map<string, {
  plays: number; games: number; redZone: number; redZoneTd: number;
  points: number;
}>> {
  const out = new Map<string, {
    plays: number; games: number; redZone: number; redZoneTd: number;
    points: number;
  }>();
  const weeks = new Map<string, Set<number>>();

  for (const r of parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
  ))) {
    if (Number(r["season"]) !== season) {
      continue;
    }

    const team = r["offense"] ?? "";

    if (!team) {
      continue;
    }

    const its = out.get(team) ??
      { plays: 0, games: 0, redZone: 0, redZoneTd: 0, points: 0 };
    its.plays++;
    const seen = weeks.get(team) ?? new Set<number>();
    seen.add(Number(r["week"]));
    weeks.set(team, seen);

    if (Number(r["yardline"]) <= 20) {
      its.redZone++;
      its.redZoneTd += Number(r["touchdown"]) || 0;
    }

    out.set(team, its);
  }

  for (const [team, its] of out) {
    its.games = Math.max(1, (weeks.get(team) ?? new Set()).size);
  }

  return out;
}

interface Signals {
  hisPpg: number;
  attemptsPerGame: number;
  accuracy: number;
  longRate: number;
  longAccuracy: number;
  averageMade: number;
  extraPerGame: number;
  clutchPerGame: number;
  playsPerGame: number;
  redZonePerGame: number;
  stallRate: number;
  indoors: number;
}

const row = (s: Signals) => [
  1,
  s.hisPpg,
  s.attemptsPerGame,
  s.accuracy,
  s.longRate,
  s.longAccuracy,
  s.averageMade / 40,
  s.extraPerGame,
  s.clutchPerGame,
  s.playsPerGame / 60,
  s.redZonePerGame / 8,
  s.stallRate,
  s.indoors,
];

async function main(): Promise<void> {
  const byYear = new Map<number, Map<string, Kicker>>();
  const offenceBy = new Map<number, Awaited<ReturnType<typeof offences>>>();

  for (const s of SEASONS) {
    byYear.set(s, await kickersIn(s));
    offenceBy.set(s, await offences(s));
  }

  /** how much of a club's home schedule is out of the weather */
  const inside = new Map<string, number>();

  for (const g of parseCsv(await readFile(join(RAW, "games.csv"), "utf8"))) {
    const home = g["home_team"] ?? "";

    if (!home) {
      continue;
    }

    const roof = (g["roof"] ?? "").replace(/"/g, "");
    const seen = inside.get(home);
    const shut = roof === "dome" || roof === "closed" ? 1 : 0;
    inside.set(home, seen === undefined ? shut : (seen + shut) / 2);
  }

  const rowsFor = async (season: number) => {
    const was = byYear.get(season - 1);
    const is = byYear.get(season);
    const offence = offenceBy.get(season - 1);
    const adp = await loadSleeperAdp(season, "standard").catch(() => new Map());
    const nowOn = new Map<string, string>();

    for (const r of await loadWeeklyRosters(season).catch(() => [])) {
      if (!nowOn.has(r.playerId)) {
        nowOn.set(r.playerId, r.teamId);
      }
    }

    const out: {
      name: string; his: number[]; adp: number; truth: number;
    }[] = [];

    for (const [id, his] of was ?? []) {
      const now = is?.get(id);

      if (!now || his.games < 6 || now.games < 6) {
        continue;
      }

      // the side he kicks for this season, which may not be last one's
      const team = nowOn.get(id) ?? his.team;
      const its = offence?.get(team);
      const stalls = its && its.redZone > 0
        ? 1 - its.redZoneTd / its.redZone
        : 0.5;
      out.push({
        name: his.name,
        his: row({
          hisPpg: his.points / his.games,
          attemptsPerGame: his.attempts / his.games,
          accuracy: his.attempts > 0 ? his.made / his.attempts : 0.85,
          longRate: his.attempts > 0 ? his.longAttempts / his.attempts : 0.2,
          longAccuracy: his.longAttempts > 0
            ? his.longMade / his.longAttempts
            : 0.6,
          averageMade: his.made > 0 ? his.madeYards / his.made : 38,
          extraPerGame: his.extraPoints / his.games,
          clutchPerGame: his.clutch / his.games,
          playsPerGame: its ? its.plays / its.games : 60,
          redZonePerGame: its ? its.redZone / its.games : 8,
          stallRate: stalls,
          indoors: inside.get(team) ?? 0,
        }),
        adp: adp.get(`${normalizeName(his.name)}|K`)?.adp ?? 250,
        truth: now.points / now.games,
      });
    }

    return out;
  };

  console.log("ordering next season's kickers");
  console.log(
    "season   men    adp   last year   pace and red zone   adp and last year",
  );
  const mean = { adp: 0, last: 0, model: 0, both: 0, n: 0 };

  for (const season of TEST) {
    const train = (await Promise.all(
      SEASONS.filter((s) => s < season && s > SEASONS[0]!).map(rowsFor),
    )).flat();
    const test = await rowsFor(season);

    if (!train.length || !test.length) {
      continue;
    }

    const fit = fitRidge(train.map((r) => r.his), train.map((r) => r.truth), 2);
    const truth = test.map((r) => r.truth);
    const placeOf = (values: number[]) => {
      const order = values.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
      const at = new Array<number>(values.length);
      order.forEach((r, k) => { at[r.i] = k + 1; });

      return at;
    };
    const byAdp = placeOf(test.map((r) => -r.adp));
    const byLast = placeOf(test.map((r) => r.his[1]!));
    const said = {
      adp: spearman(test.map((r) => -r.adp), truth),
      last: spearman(test.map((r) => r.his[1]!), truth),
      model: spearman(test.map((r) => predictRidge(fit, r.his)), truth),
      both: spearman(byAdp.map((a, i) => -(a + byLast[i]!)), truth),
    };
    console.log(
      `${season}   ${String(test.length).padStart(3)}  ${said.adp.toFixed(3)}` +
        `      ${said.last.toFixed(3)}         ${said.model.toFixed(3)}` +
        `             ${said.both.toFixed(3)}`,
    );
    mean.adp += said.adp;
    mean.last += said.last;
    mean.model += said.model;
    mean.both += said.both;
    mean.n++;
  }

  const n = Math.max(1, mean.n);
  console.log(
    `mean        ${(mean.adp / n).toFixed(3)}      ` +
      `${(mean.last / n).toFixed(3)}         ${(mean.model / n).toFixed(3)}` +
      `             ${(mean.both / n).toFixed(3)}`,
  );
}

await main();
