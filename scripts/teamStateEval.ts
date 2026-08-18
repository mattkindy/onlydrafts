/**
 * Does carrying a belief about an offence from week to week beat
 * predicting the same number every time?
 *
 * The bar is low and was not cleared before: the simulation missed a
 * team's week by 13.2 points where saying 45.3 every time missed by
 * 11.9. Fitted on 2021 to 2024, run forward through 2025 with nothing
 * from that season used before the week it belongs to.
 *
 * Run: npx tsx scripts/teamStateEval.ts
 */

import { loadGames, loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { spearman } from "../src/backtest/metrics.js";
import {
  afterTeamWeek, carryToNextSeason, expectTeamWeek, unknownTeam,
  TEAM_DEFAULTS, type TeamBelief,
} from "../src/model/teamState.js";

const RULES = presets.standard;
const SEASONS = [2021, 2022, 2023, 2024, 2025];

async function main(): Promise<void> {
  const totalOf = new Map<string, number>();

  for (const game of await loadGames()) {
    if (game.week > 18) continue;
    for (const team of [game.homeTeamId, game.awayTeamId]) {
      totalOf.set(`${game.season}|${game.week}|${team}`, game.totalLine ?? 45);
    }
  }

  const scoredIn = new Map<string, number>();

  for (const season of SEASONS) {
    for (const row of await loadPlayerStats(season)) {
      if (row.week > 18 || !["RB", "WR", "TE"].includes(row.position)) continue;
      const key = `${season}|${row.week}|${row.teamId}`;
      scoredIn.set(key, (scoredIn.get(key) ?? 0) + fantasyPoints(row.statLine, RULES));
    }
  }

  const teams = [...new Set([...scoredIn.keys()].map((k) => k.split("|")[2]!))];
  const belief = new Map<string, TeamBelief>(teams.map((t) => [t, unknownTeam()]));

  interface Row { season: number; week: number; carried: number; vegas: number; flat: number; actual: number }
  const rows: Row[] = [];

  for (const season of SEASONS) {
    for (const team of teams) {
      belief.set(team, carryToNextSeason(belief.get(team)!));
    }

    for (let week = 1; week <= 18; week++) {
      const played: [string, number, number][] = [];

      for (const team of teams) {
        const actual = scoredIn.get(`${season}|${week}|${team}`);
        const total = totalOf.get(`${season}|${week}|${team}`);
        if (actual === undefined || total === undefined) continue;

        // predict before the week is folded in
        rows.push({
          season, week, actual,
          carried: expectTeamWeek(belief.get(team)!, total),
          vegas: expectTeamWeek(unknownTeam(), total),
          flat: TEAM_DEFAULTS.leagueMean,
        });
        played.push([team, actual, total]);
      }

      for (const [team, actual, total] of played) {
        belief.set(team, afterTeamWeek(belief.get(team)!, actual, total));
      }
    }
  }

  const score = (label: string, sub: Row[]) => {
    const actual = sub.map((r) => r.actual);
    console.log("\n" + label + ", " + sub.length + " team-weeks\n");
    console.log("  predictor              spearman   average miss");

    for (const [name, get] of [
      ["the same number always", (r: Row) => r.flat],
      ["the betting total", (r: Row) => r.vegas],
      ["carried week to week", (r: Row) => r.carried],
    ] as [string, (r: Row) => number][]) {
      const guess = sub.map(get);
      const miss = guess.map((g, i) => Math.abs(g - actual[i]!));
      console.log(
        "  " + name.padEnd(24) + spearman(guess, actual).toFixed(4).padStart(8) +
        (miss.reduce((a, b) => a + b, 0) / miss.length).toFixed(2).padStart(15),
      );
    }
  };

  score("everything", rows);
  score("2025 alone", rows.filter((r) => r.season === 2025));
  score("2025 from week 6 on", rows.filter((r) => r.season === 2025 && r.week >= 6));
  // Where the carried belief has least to go on, and where a prior
  // built from the players on the roster would have most to add.
  score("every season, weeks 1 to 3", rows.filter((r) => r.week <= 3));
  score("every season, weeks 4 to 6", rows.filter((r) => r.week >= 4 && r.week <= 6));
  score("every season, week 7 on", rows.filter((r) => r.week >= 7));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
