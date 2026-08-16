/**
 * The generative model divides a team's passes and hand-offs among its
 * players, so how many of each it gets is the first thing that has to
 * be right. Vegas says who is expected to win and by how much before
 * kickoff. Does that move the mix, and does weather move the totals?
 *
 * Run: npx tsx scripts/gameScriptEval.ts
 */

import { loadGames, loadPlayerStats } from "../src/data/nflverse.js";

const SEASONS = [2021, 2022, 2023, 2024, 2025];

interface TeamGame {
  passes: number;
  rushes: number;
  spread: number;
  total: number;
  wind: number;
  indoors: boolean;
  rest: number;
}

function bucketReport(
  label: string,
  rows: TeamGame[],
  by: (r: TeamGame) => number,
  edges: number[],
): void {
  console.log("\n" + label);
  console.log("  band                  n   passes   rushes   pass share   plays");

  for (let i = 0; i <= edges.length; i++) {
    const lo = i === 0 ? -Infinity : edges[i - 1]!;
    const hi = i === edges.length ? Infinity : edges[i]!;
    const sub = rows.filter((r) => by(r) >= lo && by(r) < hi);

    if (sub.length < 30) {
      continue;
    }

    const passes = sub.reduce((a, r) => a + r.passes, 0) / sub.length;
    const rushes = sub.reduce((a, r) => a + r.rushes, 0) / sub.length;
    const name = (lo === -Infinity ? "under " + hi : hi === Infinity ? lo + " and up" : lo + " to " + hi);
    console.log(
      "  " + name.padEnd(18) + String(sub.length).padStart(5) +
      passes.toFixed(1).padStart(9) + rushes.toFixed(1).padStart(9) +
      ((passes / (passes + rushes)) * 100).toFixed(1).padStart(12) + "%" +
      (passes + rushes).toFixed(1).padStart(8),
    );
  }
}

async function main(): Promise<void> {
  const games = await loadGames();
  const rows: TeamGame[] = [];

  for (const season of SEASONS) {
    const stats = await loadPlayerStats(season);
    const byTeamWeek = new Map<string, { passes: number; rushes: number }>();

    for (const s of stats) {
      const key = `${s.teamId}|${s.week}`;
      const e = byTeamWeek.get(key) ?? { passes: 0, rushes: 0 };
      e.passes += s.targets;
      e.rushes += s.carries;
      byTeamWeek.set(key, e);
    }

    for (const game of games) {
      if (game.season !== season || game.week > 18) continue;
      const spread = game.spreadLine;
      const total = game.totalLine;
      if (spread === undefined || total === undefined) continue;

      for (const [team, ownSpread, rest] of [
        // spread_line is from the home side, so away flips the sign
        [game.homeTeamId, spread, game.homeRest ?? 7],
        [game.awayTeamId, -spread, game.awayRest ?? 7],
      ] as [string, number, number][]) {
        const counts = byTeamWeek.get(`${team}|${game.week}`);
        if (!counts || counts.passes + counts.rushes < 30) continue;
        rows.push({
          passes: counts.passes, rushes: counts.rushes,
          spread: ownSpread, total,
          wind: game.wind ?? 0,
          indoors: game.indoors,
          rest,
        });
      }
    }
  }

  console.log(`${rows.length} team-games, ${SEASONS[0]} to ${SEASONS.at(-1)}`);
  bucketReport(
    "by how much the team was favoured (negative means underdog)",
    rows, (r) => r.spread, [-9.5, -5.5, -2.5, 0.5, 3.5, 6.5, 10.5],
  );
  bucketReport("by the game's expected total", rows, (r) => r.total, [41.5, 45.5, 49.5]);
  bucketReport("by wind, outdoor games only",
    rows.filter((r) => !r.indoors), (r) => r.wind, [1, 8, 15]);
  bucketReport("by days of rest", rows, (r) => r.rest, [5, 7, 8]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
