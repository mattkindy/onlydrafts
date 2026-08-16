/**
 * Does running the weekly kernel over the schedule before kickoff beat
 * multiplying a season average by an opponent factor? Scored against
 * what players actually did, week by week, in a season the models
 * never saw.
 *
 * Run: npx tsx scripts/preseasonWeeklyEval.ts --season 2025
 */

import { buildPreseasonWorld } from "../src/features/preseason.js";
import { projectDraftExamples } from "../src/features/seasonModel.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { loadTendencies } from "../src/data/tendencies.js";
import { fantasyPoints } from "../src/scoring/fantasyPoints.js";
import { scoring, setScoring } from "../src/scoring/active.js";
import { presets } from "../src/scoring/fantasyPoints.js";
import { spearman, rmse } from "../src/backtest/metrics.js";
import { preseasonWeekly, anchorToSeason } from "../src/features/preseasonWeekly.js";

function argOf(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1]!;
}

async function main(): Promise<void> {
  setScoring(presets.standard);
  const season = Number(argOf("--season", "2025"));
  const world = await buildPreseasonWorld(season);
  const examples = await projectDraftExamples(season, world.data);
  const exampleById = new Map(examples.map((e) => [e.playerId, e]));

  const projectedPpg = new Map(world.players.map((p) => [p.playerId, p.projectedPpg]));
  const positionById = new Map(world.players.map((p) => [p.playerId, p.position]));
  const teamById = new Map(world.players.map((p) => [p.playerId, p.teamId]));

  // last season's scoring per team, for the implied total
  const prevStats = await loadPlayerStats(season - 1);
  const scored = new Map<string, { points: number; weeks: Set<number> }>();

  for (const w of prevStats) {
    const entry = scored.get(w.teamId) ?? { points: 0, weeks: new Set<number>() };
    entry.points += fantasyPoints(w.statLine, scoring());
    entry.weeks.add(w.week);
    scored.set(w.teamId, entry);
  }

  const teamScoring = new Map(
    [...scored].map(([team, e]) => [team, e.points / Math.max(1, e.weeks.size)]),
  );
  const passRate = new Map<string, number>();

  for (const [key, tendency] of await loadTendencies()) {
    const [team, s] = key.split("|");
    if (Number(s) === season - 1) passRate.set(team!, tendency.neutralPassRate);
  }

  const weekly = preseasonWeekly({
    season, games: world.games, weeklyWeights: world.weeklyWeights,
    projectedPpg, exampleById, positionById, teamById,
    oppAdjust: world.oppAdjust, teamScoring, passRate,
  });

  // what actually happened
  const actual = new Map<string, number>();

  for (const w of await loadPlayerStats(season)) {
    actual.set(w.playerId + "|" + w.week, fantasyPoints(w.statLine, scoring()));
  }

  const rows: { flat: number; model: number; anchored: number; real: number }[] = [];

  for (const [playerId, weeks] of weekly) {
    const ppg = projectedPpg.get(playerId)!;
    if (ppg < 3) continue;
    const anchored = anchorToSeason(weeks, ppg);

    for (let i = 0; i < weeks.length; i++) {
      const real = actual.get(playerId + "|" + weeks[i]!.week);
      if (real === undefined) continue;
      rows.push({
        flat: ppg * world.oppAdjust(positionById.get(playerId)!, weeks[i]!.opponent),
        model: weeks[i]!.points,
        anchored: anchored[i]!.points,
        real,
      });
    }
  }

  const real = rows.map((r) => r.real);
  console.log(`${season}, ${rows.length} player-weeks the models never saw\n`);
  console.log("method                         spearman    rmse   spread of predictions");

  for (const [label, get] of [
    ["season average times opponent", (r: typeof rows[number]) => r.flat],
    ["weekly kernel over the schedule", (r: typeof rows[number]) => r.model],
    ["weekly kernel, anchored", (r: typeof rows[number]) => r.anchored],
  ] as [string, (r: typeof rows[number]) => number][]) {
    const pred = rows.map(get);
    const mean = pred.reduce((a, b) => a + b, 0) / pred.length;
    const sd = Math.sqrt(pred.reduce((a, b) => a + (b - mean) ** 2, 0) / pred.length);
    console.log(
      label.padEnd(32) + spearman(pred, real).toFixed(4).padStart(8) +
      rmse(pred, real).toFixed(2).padStart(8) + sd.toFixed(2).padStart(11),
    );
  }

  // how much do a single player's weeks actually move?
  const spreadOf = (get: (playerId: string, i: number) => number) => {
    const spreads: number[] = [];

    for (const [playerId, weeks] of weekly) {
      if ((projectedPpg.get(playerId) ?? 0) < 6) continue;
      const vals = weeks.map((_, i) => get(playerId, i));
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      if (mean > 0) spreads.push((Math.max(...vals) - Math.min(...vals)) / mean);
    }

    spreads.sort((a, b) => a - b);
    return spreads[Math.floor(spreads.length / 2)] ?? 0;
  };

  console.log("\nfor a typical player, best week minus worst, as a share of his average:");
  console.log("  season average times opponent " +
    (spreadOf((id, i) => projectedPpg.get(id)! *
      world.oppAdjust(positionById.get(id)!, weekly.get(id)![i]!.opponent)) * 100).toFixed(0) + "%");
  console.log("  weekly kernel                 " +
    (spreadOf((id, i) => weekly.get(id)![i]!.points) * 100).toFixed(0) + "%");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
