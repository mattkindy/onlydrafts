/**
 * Where things stand. The simulation is calibrated, but a draft board
 * is a ranking, and nothing has checked whether it ranks as well as
 * the season model that the site already serves.
 *
 * Run: npx tsx scripts/standingsEval.ts
 */

import { loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { spearman } from "../src/backtest/metrics.js";
import { seededRng } from "../src/sim/rng.js";
import { normalDraw } from "../src/sim/normal.js";
import { fitRoles } from "../src/features/fitRoles.js";
import { simulateSeason, DEFAULT_SEASON } from "../src/model/seasonSim.js";
import type { Draws } from "../src/model/playerWeek.js";

const FIT_ON = 2024;
const SCORE_ON = 2025;
const RULES = presets.standard;

async function main(): Promise<void> {
  const positions = new Map<string, string>();
  const games = new Map<string, number>();
  const lastYear = new Map<string, { points: number; games: number }>();

  for (const s of await loadPlayerStats(FIT_ON)) {
    positions.set(s.playerId, s.position);
    games.set(s.playerId, (games.get(s.playerId) ?? 0) + 1);
    const own = lastYear.get(s.playerId) ?? { points: 0, games: 0 };
    own.points += fantasyPoints(s.statLine, RULES);
    own.games++;
    lastYear.set(s.playerId, own);
  }

  const { byTeam, playsByTeam } = await fitRoles(FIT_ON, positions, games);
  const rng = seededRng(55);
  const draws: Draws = { uniform: rng, normal: () => normalDraw(rng) };
  const simulated = new Map<string, ReturnType<typeof simulateSeason>[number]>();

  console.log("simulating every offence...");

  for (const [team, roster] of byTeam) {
    const plays = playsByTeam.get(team)!;
    const out = simulateSeason(
      { plays }, roster, { ...DEFAULT_SEASON, runs: 500, scoring: RULES }, draws,
    );

    for (const player of out) {
      simulated.set(player.playerId, player);
    }
  }

  // what they went on to average
  const after = new Map<string, { points: number; games: number }>();

  for (const row of await loadPlayerStats(SCORE_ON)) {
    if (row.week > 18) continue;
    const own = after.get(row.playerId) ?? { points: 0, games: 0 };
    own.points += fantasyPoints(row.statLine, RULES);
    own.games++;
    after.set(row.playerId, own);
  }

  const ids = [...simulated.keys()].filter((id) => {
    const own = after.get(id);
    const before = lastYear.get(id);
    return own && own.games >= 8 && before && before.games >= 8;
  });

  const actualPpg = ids.map((id) => after.get(id)!.points / after.get(id)!.games);
  const actualTotal = ids.map((id) => after.get(id)!.points);

  console.log(`\n${ids.length} players with a real season either side\n`);
  console.log("ranking by                        points a game   season total");

  const report = (label: string, get: (id: string) => number) => {
    const guess = ids.map(get);
    console.log(
      label.padEnd(34) +
      spearman(guess, actualPpg).toFixed(3).padStart(13) +
      spearman(guess, actualTotal).toFixed(3).padStart(15),
    );
  };

  report("what he did last year", (id) =>
    lastYear.get(id)!.points / lastYear.get(id)!.games);
  report("simulated average", (id) => simulated.get(id)!.seasonAverage.median);
  report("simulated total", (id) => simulated.get(id)!.total.median);
  report("simulated floor", (id) => simulated.get(id)!.total.p10);
  report("simulated ceiling", (id) => simulated.get(id)!.total.p90);

  // the things only a simulation gives you
  console.log("\nwhat the simulation says that a projection cannot:\n");
  const withBig = ids
    .map((id) => ({ id, sim: simulated.get(id)!, position: positions.get(id)! }))
    .sort((a, b) => b.sim.bigWeekChance - a.sim.bigWeekChance);
  const names = new Map<string, string>();

  for (const s of await loadPlayerStats(SCORE_ON)) {
    names.set(s.playerId, s.playerName);
  }

  console.log("most likely to have a week over 25:");

  for (const { id, sim } of withBig.slice(0, 6)) {
    console.log("  " + (names.get(id) ?? id).padEnd(22) +
      (sim.bigWeekChance * 100).toFixed(0) + "%   " +
      sim.seasonAverage.median.toFixed(1) + " a game");
  }

  console.log("\nsteadiest, of players averaging over 8:");
  const steady = ids
    .map((id) => ({ id, sim: simulated.get(id)! }))
    .filter((p) => p.sim.seasonAverage.median >= 8)
    .sort((a, b) =>
      (a.sim.weekly.p75 - a.sim.weekly.p25) / a.sim.seasonAverage.median -
      (b.sim.weekly.p75 - b.sim.weekly.p25) / b.sim.seasonAverage.median);

  for (const { id, sim } of steady.slice(0, 4)) {
    console.log("  " + (names.get(id) ?? id).padEnd(22) +
      sim.seasonAverage.median.toFixed(1) + " a game, middle half " +
      sim.weekly.p25.toFixed(1) + " to " + sim.weekly.p75.toFixed(1));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
