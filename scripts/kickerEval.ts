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
    const his = out.get(id) ??
      { id, name: r["player_display_name"] ?? id, team: r["team"] ?? "", games: 0, points: 0 };
    his.games++;
    his.team = r["team"] ?? his.team;
    his.points += scored(r);
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

const row = (
  hisPpg: number, plays: number, redZone: number, stallRate: number,
) => [1, hisPpg, plays, redZone, stallRate];

async function main(): Promise<void> {
  const byYear = new Map<number, Map<string, Kicker>>();
  const offenceBy = new Map<number, Awaited<ReturnType<typeof offences>>>();

  for (const s of SEASONS) {
    byYear.set(s, await kickersIn(s));
    offenceBy.set(s, await offences(s));
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
        his: row(
          his.points / his.games,
          its ? its.plays / its.games : 60,
          its ? its.redZone / its.games : 8,
          stalls,
        ),
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
