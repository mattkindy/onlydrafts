/**
 * Does the browser engine play the same game the Node simulator does?
 *
 * Both are handed the same checkpoints out of a played season and asked
 * what the rest of the game is worth. The two sides' remaining points
 * and each man's remaining points are compared, so a table that has
 * lost something shows up as a gap in one or the other.
 *
 * Run: npx tsx scripts/simAgreement.ts [season] [week] [checkpoints]
 * It wants scripts/aggregateCheckpoints.ts and scripts/buildSimTables.ts
 * to have run first.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildWorld } from "../src/features/playedWorld.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { linesFrom, playGame, type Side } from "../src/model/gameFromDrives.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { seededRng } from "../src/sim/rng.js";
import { fromCache } from "../src/backtest/checkpoints.js";
import { leagueOf, remainderFor } from "../app/lib/remainder.ts";
import type { SimTables } from "../app/lib/simTables.ts";

const SEASON = Number(process.argv[2] ?? 2024);
const WEEK = Number(process.argv[3] ?? 9);
const MOST = Number(process.argv[4] ?? 40);
const RUNS = Number(process.env["RUNS"] ?? 200);

const PPR = {
  pass_yd: 0.04, pass_td: 4, pass_int: -2, rush_yd: 0.1, rush_td: 6,
  rec: 1, rec_yd: 0.1, rec_td: 6, fum_lost: -2, rush_2pt: 2,
};

const mean = (its: number[] | Float64Array) => {
  let sum = 0;

  for (const one of its) {
    sum += one;
  }

  return its.length ? sum / its.length : 0;
};

async function main(): Promise<void> {
  const tables = JSON.parse(await readFile(
    join("docs", "data", `sim-${SEASON}.json`), "utf8")) as SimTables;
  const stops = fromCache(await readFile(
    join("data", "curated", `checkpoints-${SEASON}.csv`), "utf8"))
    .filter((one) => one.week === WEEK)
    .slice(0, MOST);
  const positions = new Map<string, string>();

  for (const row of await loadPlayerStats(SEASON - 1)) {
    positions.set(row.playerId, row.position);
  }

  const world = await buildWorld(
    SEASON, WEEK, true, positions, { componentShares: true });
  const league = leagueOf(tables);
  const byKey = new Map<string, string>();

  for (const side of Object.values(tables.teams)) {
    for (const man of side.men) {
      byKey.set(man.id, man.key);
    }
  }

  let teamGap = 0;
  let teamN = 0;
  let manGap = 0;
  let manN = 0;
  let started = Date.now();
  let nodeMillis = 0;
  let browserMillis = 0;

  for (const stop of stops) {
    const home = world.sideFor(stop.home) as Side | undefined;
    const away = world.sideFor(stop.away) as Side | undefined;

    if (!home || !away) {
      continue;
    }

    const nodeTeam: Record<string, number[]> =
      { [stop.home]: [], [stop.away]: [] };
    const nodeMen = new Map<string, number[]>();
    started = Date.now();

    for (let run = 0; run < RUNS; run++) {
      const rng = seededRng(
        stop.gameId.length * 7919 + stop.label.length * 131 +
        stop.state.secondsLeft * 31 + run * 104729);
      const game = playGame(home, away, {
        rules: { ...world.rules, kickSucceeds: world.kicking.kickSucceeds },
        fourth: world.fourth,
        clock: {
          isLast: world.kicking.isLast, lastLength: world.kicking.lastLength,
        },
        ticking: world.ticking, season: stop.season, week: stop.week,
      }, rng, {
        length: 3600, half: 1800, afterKickoff: 75, mostDrives: 40,
        from: stop.state,
      });

      for (const team of [stop.home, stop.away]) {
        nodeTeam[team]!.push(
          (game.points[team] ?? 0) - (stop.state.points[team] ?? 0));
      }

      for (const [playerId, line] of linesFrom(game, [home, away])) {
        const key = byKey.get(playerId);

        if (!key) {
          continue;
        }

        const his = nodeMen.get(key) ?? (new Array(RUNS).fill(0) as number[]);
        nodeMen.set(key, his);
        his[run] = fantasyPoints(line, presets.ppr);
      }
    }

    nodeMillis += Date.now() - started;
    started = Date.now();
    const played = remainderFor(tables, league, {
      home: stop.home, away: stop.away, points: stop.state.points,
      secondsLeft: stop.state.secondsLeft, withBall: stop.state.withBall,
      yardline: stop.state.yardline, down: stop.state.down,
      toGo: stop.state.toGo, timeouts: stop.state.timeouts,
      warningLeft: stop.state.warningLeft, secondHalf: stop.state.secondHalf,
      receivedFirst: stop.state.receivedFirst,
    }, RUNS, PPR, 12345);
    browserMillis += Date.now() - started;

    if (!played) {
      continue;
    }

    for (const team of [stop.home, stop.away]) {
      teamGap += Math.abs(
        mean(nodeTeam[team]!) - mean(played.teamPoints[team]!));
      teamN++;
    }

    for (const [key, its] of nodeMen) {
      const theirs = played.men.get(key);

      if (!theirs) {
        continue;
      }

      manGap += Math.abs(mean(its) - mean(theirs));
      manN++;
    }
  }

  console.log(`${stops.length} checkpoints, ${RUNS} runs each`);
  console.log(`team points: mean gap ${(teamGap / (teamN || 1)).toFixed(2)}`);
  console.log(`per man: mean gap ${(manGap / (manN || 1)).toFixed(2)} ` +
    `over ${manN} men`);
  console.log(`node ${(nodeMillis / (stops.length || 1)).toFixed(0)} ms a ` +
    `game, browser ${(browserMillis / (stops.length || 1)).toFixed(0)} ms`);
}

void main();
