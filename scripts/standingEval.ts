/**
 * A better measure of what a man has shown, which is what the
 * competition for a share is decided on.
 *
 * The share model places a player by what he did last season alone.
 * Three things might place him better: more than one season, since one
 * is noisy; the position budget of his own offence rather than the
 * league's, since a passing team has more to give its receivers; and
 * how old he is.
 *
 * Run: npx tsx scripts/standingEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { spearman } from "../src/backtest/metrics.js";
import { loadPlayerStats, loadWeeklyRosters } from "../src/data/nflverse.js";
import { loadDraftPicks } from "../src/data/draftPicks.js";
import { divideAmong } from "../src/features/shareCompetition.js";
import { loadAdp } from "../src/data/adp.js";
import { normalizeName } from "../src/data/names.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";

const RULES = presets.standard;

const SCORE_ON = Number(process.env["SEASON"] ?? 2025);
const POSITIONS = ["RB", "WR", "TE"];

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

interface Year {
  playerId: string;
  position: string;
  team: string;
  games: number;
  touches: number;
  share: number;
}

async function seasonOf(season: number): Promise<Map<string, Year>> {
  const plays = new Map<string, number>();

  for (const row of parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "plays.csv"), "utf8",
  ))) {
    if (Number(row["season"]) !== season) continue;
    if (!["run", "pass"].includes(row["playType"] ?? "")) continue;
    plays.set(row["offense"] ?? "", (plays.get(row["offense"] ?? "") ?? 0) + 1);
  }

  const tally = new Map<string, Year>();

  for (const s of await loadPlayerStats(season)) {
    if (s.week > 18 || !POSITIONS.includes(s.position)) continue;
    const own = tally.get(s.playerId) ?? {
      playerId: s.playerId, position: s.position, team: s.teamId,
      games: 0, touches: 0, share: 0,
    };
    own.games++;
    own.touches += s.carries + s.targets;
    own.team = s.teamId;
    tally.set(s.playerId, own);
  }

  for (const own of tally.values()) {
    own.share = own.touches / (plays.get(own.team) ?? 1000);
  }

  return tally;
}

async function main(): Promise<void> {
  const seasons = new Map<number, Map<string, Year>>();

  for (const season of [SCORE_ON - 3, SCORE_ON - 2, SCORE_ON - 1, SCORE_ON]) {
    seasons.set(season, await seasonOf(season));
  }

  const now = seasons.get(SCORE_ON)!;
  const picks = await loadDraftPicks();

  // how much of an offence each position takes, per team and overall
  const budget = new Map<string, number>();
  const leagueBudget = new Map<string, number[]>();

  for (const season of [SCORE_ON - 2, SCORE_ON - 1]) {
    const byTeam = new Map<string, Map<string, number>>();

    for (const man of seasons.get(season)!.values()) {
      const own = byTeam.get(man.team) ?? new Map<string, number>();
      own.set(man.position, (own.get(man.position) ?? 0) + man.share);
      byTeam.set(man.team, own);
    }

    for (const [team, own] of byTeam) {
      for (const position of POSITIONS) {
        const key = `${team}|${position}`;
        budget.set(key, (budget.get(key) ?? 0) + (own.get(position) ?? 0) / 2);
        leagueBudget.set(position, [
          ...(leagueBudget.get(position) ?? []), own.get(position) ?? 0,
        ]);
      }
    }
  }

  const experience = new Map<string, number>();

  for (const row of await loadWeeklyRosters(SCORE_ON - 1)) {
    if (row.yearsExperience !== undefined) {
      experience.set(row.playerId, row.yearsExperience);
    }
  }

  // rookie standing by round, from the seasons before this one
  const asRookie = new Map<string, number[]>();

  for (const season of [SCORE_ON - 3, SCORE_ON - 2, SCORE_ON - 1]) {
    for (const man of (seasons.get(season) ?? new Map<string, Year>()).values()) {
      const pick = picks.get(man.playerId);
      if (!pick || pick.season !== season) continue;
      const key = `${man.position}|${Math.min(pick.round, 5)}`;
      asRookie.set(key, [...(asRookie.get(key) ?? []), man.share]);
    }
  }

  const rookieShare = (position: string, round: number) => {
    for (const step of [0, -1, 1, -2, 2, -3, 3]) {
      const at = Math.min(5, Math.max(1, round + step));
      const seen = asRookie.get(`${position}|${at}`) ?? [];
      if (seen.length >= 4) return middle(seen);
    }
    return 0.02;
  };

  /** what a man has shown, from however many seasons back we look */
  const standing = (
    playerId: string, position: string, back: number,
    weights: number[] = [1, 0.55, 0.3],
  ) => {
    let total = 0;
    let weight = 0;
    let anySeason = false;

    for (let i = 0; i < back; i++) {
      const was = seasons.get(SCORE_ON - 1 - i)?.get(playerId);
      if (!was) continue;
      anySeason = true;
      total += weights[i]! * was.share;
      weight += weights[i]!;
    }

    if (!anySeason) {
      const pick = picks.get(playerId);
      return pick ? rookieShare(position, pick.round) : 0;
    }

    return total / weight;
  };

  const teamsNow = new Map<string, Year[]>();

  for (const man of now.values()) {
    teamsNow.set(man.team, [...(teamsNow.get(man.team) ?? []), man]);
  }

  const ways: [string, (playerId: string, position: string, team: string) => number][] = [];
  const built = new Map<string, Map<string, number>>();

  const build = (
    label: string, back: number, ownBudget: boolean, byAge: boolean,
    weights?: number[],
  ) => {
    const said = new Map<string, number>();

    for (const [team, roster] of teamsNow) {
      for (const position of POSITIONS) {
        const group = roster.filter((m) => m.position === position);
        if (!group.length) continue;
        const total = ownBudget
          ? budget.get(`${team}|${position}`) ??
            middle(leagueBudget.get(position) ?? [0.2])
          : middle(leagueBudget.get(position) ?? [0.2]);
        const shares = divideAmong(
          group.map((man) => {
            let show = standing(man.playerId, position, back, weights);

            if (byAge) {
              // a back past his eighth year loses work, a receiver later
              const years = experience.get(man.playerId) ?? 3;
              const over = position === "RB" ? 7 : 9;
              if (years > over) show *= Math.pow(0.88, years - over);
            }

            return { playerId: man.playerId, standing: show };
          }),
          total,
        );

        for (const [playerId, share] of shares) said.set(playerId, share);
      }
    }

    built.set(label, said);
    ways.push([label, (playerId) => said.get(playerId) ?? 0]);
  };

  build("one season, league budget", 1, false, false);
  build("three seasons", 3, false, false);
  build("three, his team's budget", 3, true, false);
  build("three, his team's, aged", 3, true, true);
  // how much the season before last is worth, judged on the men a
  // draft is actually about rather than on everybody with a snap
  for (const older of [0.15, 0.3, 0.45]) {
    build(`last season, older at ${older}`, 3, false, false, [1, older, older / 2]);
  }

  const men = [...now.values()];
  const truth = men.map((m) => m.share);

  console.log(`${men.length} men in ${SCORE_ON}\n`);
  console.log("guessing his share of the plays   spearman");

  for (const [label, of] of ways) {
    console.log(
      "  " + label.padEnd(30) +
      spearman(men.map((m) => of(m.playerId, m.position, m.team)), truth)
        .toFixed(4).padStart(7),
    );
  }
  // and the question that matters: against adp, on the men it
  // priced, with the two mixed as places
  const adp = await loadAdp(SCORE_ON, "ppr").catch(() => new Map());
  const names = new Map<string, string>();
  const scored = new Map<string, number>();

  for (const s of await loadPlayerStats(SCORE_ON)) {
    if (s.week > 18) continue;
    names.set(s.playerId, s.playerName);
    scored.set(
      s.playerId, (scored.get(s.playerId) ?? 0) + fantasyPoints(s.statLine, RULES),
    );
  }

  const priced = men.map((man) => ({
    man,
    adp: adp.get(
      `${normalizeName(names.get(man.playerId) ?? "")}|${man.position}`,
    )?.adp ?? null,
    points: scored.get(man.playerId) ?? 0,
  })).filter((row) => row.adp !== null);

  const place = (values: number[]) => {
    const order = values.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
    const out = new Array<number>(values.length);
    order.forEach((o, rank) => { out[o.i] = rank + 1; });
    return out;
  };

  const pricedTruth = priced.map((p) => p.points);
  const adpPlace = place(priced.map((p) => -p.adp!));
  const best = built.get(process.env["USE"] ?? "three seasons")!;
  const plays = new Map<string, number>();

  for (const row of parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "plays.csv"), "utf8",
  ))) {
    if (Number(row["season"]) !== SCORE_ON) continue;
    if (!["run", "pass"].includes(row["playType"] ?? "")) continue;
    plays.set(row["offense"] ?? "", (plays.get(row["offense"] ?? "") ?? 0) + 1);
  }

  const modelPlace = place(priced.map((p) =>
    (best.get(p.man.playerId) ?? 0) * (plays.get(p.man.team) ?? 1000)));

  console.log(`\nagainst adp, ${priced.length} men it priced   spearman`);

  for (const [label, said] of built) {
    const at = place(priced.map((p) =>
      (said.get(p.man.playerId) ?? 0) * (plays.get(p.man.team) ?? 1000)));
    console.log(
      "  " + label.padEnd(30) +
      spearman(at.map((r) => -r), pricedTruth).toFixed(4).padStart(7),
    );
  }

  console.log(
    "\n  the one being mixed below     " +
    spearman(modelPlace.map((r) => -r), pricedTruth).toFixed(4).padStart(7),
  );
  console.log(
    "  where adp had him    " +
    spearman(adpPlace.map((r) => -r), pricedTruth).toFixed(4).padStart(7),
  );
  console.log("\n  leaning on the model by   together");

  for (const lean of [0.2, 0.25, 0.3, 0.4, 0.5]) {
    const mixed = modelPlace.map((m, i) => -(lean * m + (1 - lean) * adpPlace[i]!));
    console.log(
      `    ${(100 * lean).toFixed(0)}%`.padEnd(28) +
      spearman(mixed, pricedTruth).toFixed(4),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
