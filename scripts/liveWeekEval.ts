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
import { acrossCores, myShare } from "../src/sim/acrossCores.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SEASONS = (process.env["SEASONS_ARG"] ?? process.argv[2] ?? "2025").split(",").map(Number);
const WEEKS = [3, 5, 7, 9, 11, 13, 15, 17];
const RUNS = Number(process.env["RUNS"] ?? 20);

const rows = parseCsv(await readFile(
  join(import.meta.dirname, "..", "data", "raw", "games.csv"), "utf8"));
const pooledWalk: number[] = [];
const pooledLine: number[] = [];
const pooledWas: number[] = [];

/**
 * Each season and week pair is its own world and its own games, so the
 * pairs cut across the cores. A share prints its triples as one JSON
 * line and the parent pools them.
 */
const asShare = process.env["SHARE"] !== undefined;
const jobs = SEASONS.flatMap((season) => WEEKS.map((week) => ({ season, week })));
const mine = new Set(
  myShare(jobs.map((_, i) => i)),
);

if (!asShare) {
  const printed = await acrossCores({
    script: import.meta.filename,
    env: {
      RUNS: String(RUNS),
      SEASONS_ARG: SEASONS.join(","),
      ...(process.env["TEAM_DRIVES"] ? { TEAM_DRIVES: process.env["TEAM_DRIVES"]! } : {}),
    },
  });

  for (const lineOut of printed) {
    const got = JSON.parse(lineOut) as { walk: number[]; line: number[]; was: number[] };
    pooledWalk.push(...got.walk);
    pooledLine.push(...got.line);
    pooledWas.push(...got.was);
  }

  const flat = new Array(pooledWas.length)
    .fill(pooledWas.reduce((a, b) => a + b, 0) / pooledWas.length);

  console.log(`pooled over ${pooledWas.length} games: ` +
    `walk ${rmse(pooledWalk, pooledWas).toFixed(2)}, ` +
    `line ${rmse(pooledLine, pooledWas).toFixed(2)}, ` +
    `average ${rmse(flat, pooledWas).toFixed(2)}`);
  process.exit(0);
}

let at = -1;

for (const SEASON of SEASONS) {
const positions = new Map<string, string>();

for (const s of await loadPlayerStats(SEASON - 1)) {
  positions.set(s.playerId, s.position);
}



for (const week of WEEKS) {
  at++;

  if (!mine.has(at)) {
    continue;
  }

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

  pooledWalk.push(...walk);
  pooledLine.push(...line);
  pooledWas.push(...was);
}
}

console.log(JSON.stringify({ walk: pooledWalk, line: pooledLine, was: pooledWas }));
