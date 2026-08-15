// Builds the league graph from downloaded data and prints a summary,
// as a sanity check on the parsers and stint merging. Run with:
//   npx tsx scripts/inspectGraph.ts --seasons 2023-2024

import { buildGraph } from "../src/graph/build.js";
import {
  loadGames,
  loadPlayerStats,
  loadWeeklyRosters,
} from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { teamOf } from "../src/graph/types.js";

function parseSeasons(arg: string | undefined): number[] {
  const fallback = [2023, 2024];

  if (!arg) {
    return fallback;
  }

  const range = arg.match(/^(\d{4})-(\d{4})$/);

  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }

  return arg.split(",").map(Number);
}

async function main(): Promise<void> {
  const flag = process.argv.indexOf("--seasons");
  const seasons = parseSeasons(
    flag === -1 ? undefined : process.argv[flag + 1],
  );

  const allGames = await loadGames();
  const games = allGames.filter((g) => seasons.includes(g.season));
  const rosters = (
    await Promise.all(seasons.map((s) => loadWeeklyRosters(s)))
  ).flat();

  const { graph, skippedPositions } = buildGraph(rosters, games);

  console.log(`seasons: ${seasons.join(", ")}`);
  console.log(`players: ${graph.players.size}`);
  console.log(`teams: ${graph.teams.size}`);
  console.log(`games: ${graph.games.length}`);
  console.log(`player stints: ${graph.playerStints.length}`);

  const moved = new Map<string, number>();

  for (const stint of graph.playerStints) {
    moved.set(stint.playerId, (moved.get(stint.playerId) ?? 0) + 1);
  }

  const movers = [...moved.values()].filter((count) => count > 1).length;
  console.log(`players with more than one stint: ${movers}`);

  if (skippedPositions.size > 0) {
    const summary = [...skippedPositions.entries()]
      .map(([label, count]) => `${label}=${count}`)
      .join(", ");
    console.log(`skipped positions: ${summary}`);
  }

  const lastSeason = seasons[seasons.length - 1]!;
  const stats = await loadPlayerStats(lastSeason);
  const totals = new Map<string, number>();

  for (const week of stats) {
    const points = fantasyPoints(week.statLine, presets.ppr);
    totals.set(week.playerId, (totals.get(week.playerId) ?? 0) + points);
  }

  const top = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  console.log(`\ntop 10 by PPR points, ${lastSeason}:`);

  for (const [playerId, points] of top) {
    const player = graph.players.get(playerId);
    const team = teamOf(graph, playerId, { season: lastSeason, week: 18 });
    const label = player ? `${player.name} (${player.position}, ${team})` : playerId;
    console.log(`  ${points.toFixed(1).padStart(7)}  ${label}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
