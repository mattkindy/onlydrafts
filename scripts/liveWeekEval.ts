/**
 * Does the live walk get better as the season gives it more weeks?
 *
 * Each tested week rebuilds the world as it looked that Tuesday, plays
 * that week's fixtures, and scores the margins against the line and
 * against guessing the average. If the in season learning works, the
 * gap to the line should close as the weeks accumulate.
 *
 * Run: npx tsx scripts/liveWeekEval.ts [season]
 */

import { buildWorld } from "../src/features/playedWorld.js";
import { playGame, type Side } from "../src/model/gameFromDrives.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { parseCsv } from "../src/data/csv.js";
import { seededRng } from "../src/sim/rng.js";
import { rmse } from "../src/backtest/metrics.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SEASON = Number(process.argv[2] ?? 2025);
const WEEKS = [3, 6, 9, 12, 15, 17];
const RUNS = Number(process.env["RUNS"] ?? 20);

const positions = new Map<string, string>();

for (const s of await loadPlayerStats(SEASON - 1)) {
  positions.set(s.playerId, s.position);
}

const rows = parseCsv(await readFile(
  join(import.meta.dirname, "..", "data", "raw", "games.csv"), "utf8"));

console.log(`week   walk    line    average   games`);

for (const week of WEEKS) {
  const world = await buildWorld(SEASON, week, true, positions);
  const rng = seededRng(41);
  const walk: number[] = [];
  const line: number[] = [];
  const was: number[] = [];

  for (const r of rows) {
    if (r["game_type"] !== "REG" || Number(r["season"]) !== SEASON ||
        Number(r["week"]) !== week) {
      continue;
    }

    const homeScore = Number(r["home_score"]);
    const awayScore = Number(r["away_score"]);
    const priced = Number(r["spread_line"]);
    const home = world.sideFor(r["home_team"]!);
    const away = world.sideFor(r["away_team"]!);

    if (!home || !away || !Number.isFinite(homeScore) ||
        !Number.isFinite(priced)) {
      continue;
    }

    let saidHome = 0;
    let saidAway = 0;

    for (let run = 0; run < RUNS; run++) {
      const game = playGame(home as Side, away as Side, {
        rules: { ...world.rules, kickSucceeds: world.kicking.kickSucceeds },
        fourth: world.fourth,
        clock: { isLast: world.kicking.isLast, lastLength: world.kicking.lastLength },
        ticking: world.ticking, week,
      }, rng);
      saidHome += game.points[r["home_team"]!] ?? 0;
      saidAway += game.points[r["away_team"]!] ?? 0;
    }

    walk.push((saidHome - saidAway) / RUNS);
    line.push(priced);
    was.push(homeScore - awayScore);
  }

  if (was.length < 8) {
    console.log(`  ${week}   too few games played (${was.length})`);
    continue;
  }

  const average = new Array(was.length)
    .fill(was.reduce((a, b) => a + b, 0) / was.length);

  console.log(
    `  ${String(week).padStart(2)}   ${rmse(walk, was).toFixed(2)}   ` +
    `${rmse(line, was).toFixed(2)}   ${rmse(average, was).toFixed(2).padStart(7)}   ${was.length}`,
  );
}
