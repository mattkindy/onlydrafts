/**
 * What drives end as, at a sample size that settles.
 *
 * The spot checks used six matchups and forty runs, and kicks a side
 * moved a tenth between reruns, which is the size of the thing being
 * measured. This plays the whole fixture list across the cores.
 *
 * Run: npx tsx scripts/endingsEval.ts [season]
 */

import { buildWorld } from "../src/features/playedWorld.js";
import { playGame, type Side } from "../src/model/gameFromDrives.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { parseCsv } from "../src/data/csv.js";
import { kickoffsIn } from "../src/data/gameWeather.js";
import { seededRng } from "../src/sim/rng.js";
import { acrossCores, myShare } from "../src/sim/acrossCores.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SEASON = Number(process.env["SEASON"] ?? process.argv[2] ?? 2024);
const RUNS = Number(process.env["RUNS"] ?? 30);
const asShare = process.env["SHARE"] !== undefined;

if (!asShare) {
  const printed = await acrossCores({
    script: import.meta.filename,
    env: {
      SEASON: String(SEASON), RUNS: String(RUNS),
      ...(process.env["FIELD_CLOSER"]
        ? { FIELD_CLOSER: process.env["FIELD_CLOSER"]! } : {}),
    },
  });
  const endings = new Map<string, number>();
  let games = 0;
  let points = 0;
  const margins: number[] = [];
  const totals: number[] = [];
  const kicksHist = [0, 0, 0, 0, 0];
  let reached20 = 0;
  let scored20 = 0;

  for (const line of printed) {
    const got = JSON.parse(line) as {
      endings: Record<string, number>; games: number; points: number;
      margins: number[]; totals: number[]; kicksHist: number[];
    };
    games += got.games;
    points += got.points;
    margins.push(...got.margins);
    totals.push(...got.totals);
    got.kicksHist.forEach((v, i) => { kicksHist[i]! += v; });
    reached20 += (got as unknown as { reached20: number }).reached20;
    scored20 += (got as unknown as { scored20: number }).scored20;

    for (const [k, v] of Object.entries(got.endings)) {
      endings.set(k, (endings.get(k) ?? 0) + v);
    }
  }

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = (xs: number[]) => {
    const m = mean(xs);

    return Math.sqrt(mean(xs.map((v) => (v - m) ** 2)));
  };
  const oneScore = margins.filter((m) => Math.abs(m) <= 8).length / margins.length;
  const blowouts = margins.filter((m) => Math.abs(m) >= 17).length / margins.length;
  const sides = kicksHist.reduce((a, b) => a + b, 0);

  console.log(
    `shape: margin sd ${sd(margins).toFixed(1)} (14.4), ` +
    `one score ${(100 * oneScore).toFixed(0)}% (56%), ` +
    `blowouts ${(100 * blowouts).toFixed(0)}% (28%), ` +
    `total sd ${sd(totals).toFixed(1)} (13.1)`,
  );
  console.log(
    `kicks a side: ` + kicksHist
      .map((v, i) => `${i}${i === 4 ? "+" : ""}:${(100 * v / sides).toFixed(0)}%`)
      .join("  ") + `   (played 11/26/32/18/14)`,
  );

  const drives = [...endings.values()].reduce((a, b) => a + b, 0);
  console.log(
    `reach: ${(100 * reached20 / drives).toFixed(1)}% of drives touch the 20 ` +
    `(played 44), and ${(100 * scored20 / reached20).toFixed(1)}% of those score ` +
    `(played 50)`,
  );
  const kicks = (endings.get("fieldGoal") ?? 0) + (endings.get("missedKick") ?? 0);

  console.log(`${games} games, ${(points / games).toFixed(1)} points, ` +
    `${(drives / games).toFixed(1)} drives, ` +
    `kicks a side ${(kicks / games / 2).toFixed(3)}`);

  for (const [k, v] of [...endings].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(12)} ${(100 * v / drives).toFixed(2)}%`);
  }

  process.exit(0);
}

const positions = new Map<string, string>();

for (const s of await loadPlayerStats(SEASON - 1)) {
  positions.set(s.playerId, s.position);
}

const world = await buildWorld(SEASON, 1, false, positions);
const rows = parseCsv(await readFile(
  join(import.meta.dirname, "..", "data", "raw", "games.csv"), "utf8"));
const fixtures = myShare(kickoffsIn(rows, SEASON));
const rng = seededRng(19 + Number(process.env["SHARE"]));
const endings: Record<string, number> = {};
let games = 0;
let points = 0;
const margins: number[] = [];
const totals: number[] = [];
const kicksHist = [0, 0, 0, 0, 0];
let reached20 = 0;
let scored20 = 0;

for (const f of fixtures) {
  const home = world.sideFor(f.homeTeam);
  const away = world.sideFor(f.awayTeam);

  if (!home || !away) {
    continue;
  }

  for (let run = 0; run < RUNS; run++) {
    const game = playGame(home as Side, away as Side, {
      rules: { ...world.rules, kickSucceeds: world.kicking.kickSucceeds },
      fourth: world.fourth,
      clock: { isLast: world.kicking.isLast, lastLength: world.kicking.lastLength },
      ticking: world.ticking, week: f.week,
    }, rng);
    games++;
    const homePts = game.points[f.homeTeam] ?? 0;
    const awayPts = game.points[f.awayTeam] ?? 0;
    points += homePts + awayPts;
    margins.push(homePts - awayPts);
    totals.push(homePts + awayPts);
    const kicksBy: Record<string, number> = {};

    for (const p of game.possessions) {
      endings[p.drive.ending] = (endings[p.drive.ending] ?? 0) + 1;
      const closest = Math.min(
        100, ...p.drive.plays.map((pl) => pl.state.yardline),
      );

      if (closest <= 20) {
        reached20++;

        if (p.drive.ending === "touchdown") {
          scored20++;
        }
      }

      if (p.drive.ending === "fieldGoal" || p.drive.ending === "missedKick") {
        kicksBy[p.team] = (kicksBy[p.team] ?? 0) + 1;
      }
    }

    kicksHist[Math.min(4, kicksBy[f.homeTeam] ?? 0)]! += 1;
    kicksHist[Math.min(4, kicksBy[f.awayTeam] ?? 0)]! += 1;
  }
}

console.log(JSON.stringify({
  endings, games, points, margins, totals, kicksHist, reached20, scored20,
}));
