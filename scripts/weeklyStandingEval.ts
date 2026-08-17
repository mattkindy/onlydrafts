/**
 * How well does each model call a single week?
 *
 * Two questions hide inside that. Across players, who scores more this
 * Sunday, which is what setting a lineup needs. And within one player,
 * which of his weeks are the good ones, which needs to know the
 * opponent and the state of the offence that week.
 *
 * Run: npx tsx scripts/weeklyStandingEval.ts
 */

import { loadGames, loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { spearman, rmse } from "../src/backtest/metrics.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import { weeklyExamplesForSeason, weeklyRow } from "../src/features/weeklyModel.js";
import { seededRng } from "../src/sim/rng.js";
import { normalDraw } from "../src/sim/normal.js";
import { fitRoles } from "../src/features/fitRoles.js";
import { simulateSeason, DEFAULT_SEASON } from "../src/model/seasonSim.js";
import { setScoring } from "../src/scoring/active.js";
import type { Draws } from "../src/model/playerWeek.js";

const RULES = presets.standard;
const SCORE_ON = 2025;

async function main(): Promise<void> {
  setScoring(RULES);
  const positions = new Map<string, string>();
  const games = new Map<string, number>();
  const lastYear = new Map<string, { points: number; games: number }>();

  for (const s of await loadPlayerStats(SCORE_ON - 1)) {
    positions.set(s.playerId, s.position);
    games.set(s.playerId, (games.get(s.playerId) ?? 0) + 1);
    const own = lastYear.get(s.playerId) ?? { points: 0, games: 0 };
    own.points += fantasyPoints(s.statLine, RULES);
    own.games++;
    lastYear.set(s.playerId, own);
  }

  // the simulation, which knows nothing about any particular week
  const { byTeam, playsByTeam } = await fitRoles(SCORE_ON - 1, positions, games);
  const rng = seededRng(55);
  const draws: Draws = { uniform: rng, normal: () => normalDraw(rng) };
  const simulated = new Map<string, number>();

  for (const [team, roster] of byTeam) {
    for (const player of simulateSeason(
      { plays: playsByTeam.get(team)! }, roster,
      { ...DEFAULT_SEASON, runs: 300, scoring: RULES }, draws,
    )) {
      simulated.set(player.playerId, player.weekly.median);
    }
  }

  // the weekly model, which knows the opponent and how he has been going
  const allGames = await loadGames();
  const train = [];

  for (let season = 2016; season < SCORE_ON; season++) {
    train.push(...(await weeklyExamplesForSeason(season, allGames)));
  }

  const weights = fitRidge(train.map(weeklyRow), train.map((e) => e.target), 25);
  const test = await weeklyExamplesForSeason(SCORE_ON, allGames);

  const rows = test
    .filter((e) => simulated.has(e.playerId) && lastYear.has(e.playerId))
    .map((e) => ({
      playerId: e.playerId,
      actual: e.target,
      weekly: predictRidge(weights, weeklyRow(e)),
      simulated: simulated.get(e.playerId)!,
      lastSeason: lastYear.get(e.playerId)!.points / lastYear.get(e.playerId)!.games,
    }));

  console.log(`${rows.length} player-weeks in ${SCORE_ON}\n`);
  console.log("across players, who outscores whom this week\n");
  console.log("model                       spearman    rmse");

  const actual = rows.map((r) => r.actual);

  for (const [label, get] of [
    ["last season's average", (r: (typeof rows)[number]) => r.lastSeason],
    ["the simulation", (r: (typeof rows)[number]) => r.simulated],
    ["the weekly model", (r: (typeof rows)[number]) => r.weekly],
  ] as [string, (r: (typeof rows)[number]) => number][]) {
    const guess = rows.map(get);
    console.log(
      label.padEnd(26) + spearman(guess, actual).toFixed(4).padStart(9) +
      rmse(guess, actual).toFixed(2).padStart(8),
    );
  }

  // How many points, and how close is anyone allowed to get? The
  // oracle knows each man's actual 2025 average, which no model could,
  // and it still has to guess every week the same. Whatever error it
  // has left is the part of a week nobody predicts.
  const seasonAverage = new Map<string, { points: number; games: number }>();

  for (const row of rows) {
    const own = seasonAverage.get(row.playerId) ?? { points: 0, games: 0 };
    own.points += row.actual;
    own.games++;
    seasonAverage.set(row.playerId, own);
  }

  console.log("\nhow many points, in points\n");
  console.log("model                        average miss   typical miss   within 5   within 10");

  const mean = actual.reduce((a, b) => a + b, 0) / actual.length;
  console.log("  the average week is " + mean.toFixed(1) + " points\n");

  for (const [label, get] of [
    ["last season's average", (r: (typeof rows)[number]) => r.lastSeason],
    ["the simulation", (r: (typeof rows)[number]) => r.simulated],
    ["the weekly model", (r: (typeof rows)[number]) => r.weekly],
    ["knowing his 2025 average", (r: (typeof rows)[number]) => {
      const own = seasonAverage.get(r.playerId)!;
      return own.points / own.games;
    }],
  ] as [string, (r: (typeof rows)[number]) => number][]) {
    const guess = rows.map(get);
    const misses = guess.map((g, i) => Math.abs(g - actual[i]!));
    console.log(
      label.padEnd(28) +
      (misses.reduce((a, b) => a + b, 0) / misses.length).toFixed(2).padStart(11) +
      rmse(guess, actual).toFixed(2).padStart(15) +
      ((misses.filter((m) => m <= 5).length / misses.length) * 100).toFixed(0).padStart(10) + "%" +
      ((misses.filter((m) => m <= 10).length / misses.length) * 100).toFixed(0).padStart(11) + "%",
    );
  }

  // and the harder one: within a single player, which weeks are good
  const byPlayer = new Map<string, typeof rows>();

  for (const row of rows) {
    byPlayer.set(row.playerId, [...(byPlayer.get(row.playerId) ?? []), row]);
  }

  console.log("\nwithin one player, which of his weeks are the good ones\n");
  console.log("model                       spearman   players");

  for (const [label, get] of [
    ["the simulation", (r: (typeof rows)[number]) => r.simulated],
    ["the weekly model", (r: (typeof rows)[number]) => r.weekly],
  ] as [string, (r: (typeof rows)[number]) => number][]) {
    const scores: number[] = [];

    for (const weeks of byPlayer.values()) {
      if (weeks.length < 10) continue;
      const guess = weeks.map(get);

      if (new Set(guess).size < 3) {
        scores.push(0);
        continue;
      }

      scores.push(spearman(guess, weeks.map((w) => w.actual)));
    }

    console.log(
      label.padEnd(26) +
      (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(4).padStart(9) +
      String(scores.length).padStart(10),
    );
  }

  console.log("\nthe simulation gives a man the same number every week,");
  console.log("so within one player it can only score zero");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
