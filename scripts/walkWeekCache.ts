/**
 * Plays the walk for a set of weeks once and writes what each man scored
 * to data/curated/walkWeekly.csv, so a bench can read the walk's numbers
 * without playing the games again.
 *
 * A week of the walk at forty runs costs minutes, and the pair bench wants
 * several ways of mixing the walk with other projections. Playing the games
 * once and keeping the answer is the difference between a bench that runs
 * in seconds and one that runs in a quarter of an hour.
 *
 * The world is built live, so each week is what someone knew that Tuesday.
 *
 * Run: npx tsx scripts/walkWeekCache.ts [--seasons 2024,2025] [--weeks 3,5,7]
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { buildWorld } from "../src/features/playedWorld.js";
import { walkWeek } from "../src/features/walkWeek.js";
import { presets } from "../src/scoring/fantasyPoints.js";
import { acrossCores, myShare } from "../src/sim/acrossCores.js";
import {
  WALK_WEEKLY_PATH,
  walkRowsToCsv,
  walkWeeklyPathFor,
  type WalkWeekRow,
} from "../src/features/walkWeeklyCache.js";

const RUNS = Number(process.env["RUNS"] ?? 40);

/**
 * How many shares to cut the weeks into. Each keeps the whole play store
 * in memory, so ten of them on twelve cores had not finished a week in
 * fifty minutes, where one share plays a week in under two.
 */
const SHARES = Number(process.env["SHARES"] ?? 6);

/**
 * Which walk to play. `component` takes each man's cut of the work from
 * his trailing usage instead of August's projection, and writes its own
 * file so the bench can read both at once.
 */
const VARIANT = process.env["VARIANT"] ?? "";
const componentShares = VARIANT.includes("component");
/**
 * `component-rates` adds the per-man reconciliation on top of the shares,
 * and `component-full` adds the pass-catcher fallback and the sacks. The
 * sacks come in through `POOL_WASTE`, which fitPlayFactors reads off the
 * environment once, so a share gets it when it is spawned rather than
 * from an option.
 */
const componentRates = VARIANT.includes("rates") || VARIANT.includes("full");
const standIn = VARIANT.includes("full");
const poolWaste: Record<string, string> = standIn ? { POOL_WASTE: "1" } : {};
const outPath = VARIANT ? walkWeeklyPathFor(VARIANT) : WALK_WEEKLY_PATH;
const RULES = presets.ppr;
const POSITIONS = ["QB", "RB", "WR", "TE"];

function listFrom(name: string, fallback: number[]): number[] {
  const fromEnv = process.env[name];

  if (fromEnv) {
    return fromEnv.split(",").map(Number);
  }

  const flag = process.argv.indexOf(`--${name.toLowerCase()}`);

  if (flag === -1) {
    return fallback;
  }

  return process.argv[flag + 1]!.split(",").map(Number);
}

const seasons = listFrom("SEASONS", [2024, 2025]);
const weeks = listFrom("WEEKS", [3, 5, 7, 9, 11, 13, 15, 17]);
const jobs = seasons.flatMap((season) => weeks.map((week) => ({ season, week })));
const mine = new Set(myShare(jobs.map((_, i) => i)));
const asShare = process.env["SHARE"] !== undefined;

const games = parseCsv(
  await readFile(
    join(import.meta.dirname, "..", "data", "raw", "games.csv"),
    "utf8",
  ),
);

async function oneWeek(season: number, week: number): Promise<WalkWeekRow[]> {
  const positions = new Map<string, string>();

  for (const s of await loadPlayerStats(season)) {
    positions.set(s.playerId, s.position);
  }

  const world = await buildWorld(season, week, true, positions, {
    componentShares,
    componentRates,
    standIn,
  });
  const walked = walkWeek(world, season, week, games, RULES, RUNS);
  const rows: WalkWeekRow[] = [];

  for (const [playerId, points] of walked.points) {
    const position = positions.get(playerId) ?? "";

    if (!POSITIONS.includes(position)) {
      continue;
    }

    rows.push({
      season,
      week,
      playerId,
      position,
      points,
      touches: walked.touches.get(playerId) ?? 0,
      tds: walked.tds.get(playerId) ?? 0,
      dealt: walked.perRun.get(playerId) ?? [],
    });
  }

  console.error(
    `  ${season} week ${week}: ${walked.played} fixtures, ${rows.length} men`,
  );

  return rows;
}

if (asShare) {
  const collected: WalkWeekRow[] = [];

  for (let i = 0; i < jobs.length; i++) {
    if (!mine.has(i)) {
      continue;
    }

    collected.push(...(await oneWeek(jobs[i]!.season, jobs[i]!.week)));
  }

  console.log(JSON.stringify(collected));
} else {
  const printed = await acrossCores({
    script: import.meta.filename,
    shares: SHARES,
    env: {
      RUNS: String(RUNS),
      SEASONS: seasons.join(","),
      WEEKS: weeks.join(","),
      VARIANT,
      ...poolWaste,
    },
  });
  const all: WalkWeekRow[] = [];

  for (const line of printed) {
    all.push(...(JSON.parse(line) as WalkWeekRow[]));
  }

  all.sort(
    (a, b) =>
      a.season - b.season ||
      a.week - b.week ||
      a.playerId.localeCompare(b.playerId),
  );
  await writeFile(outPath, walkRowsToCsv(all));
  console.log(
    `wrote ${all.length} rows for ${seasons.join(",")} weeks ${weeks.join(",")} at ${RUNS} runs`,
  );
}
