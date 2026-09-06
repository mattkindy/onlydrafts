/**
 * Downloads Sleeper's weekly projections and writes them to
 * data/curated/sleeperWeekly.csv, one row per player-week, keyed by gsis id.
 *
 * The endpoint needs no auth, so the only politeness is going one week at a
 * time with a pause between calls. A week nobody has projected yet comes
 * back empty, which is how the current season stops itself.
 *
 * Run: npx tsx scripts/fetchSleeperProjections.ts [--seasons 2024,2025,2026]
 */

import { writeFile } from "node:fs/promises";
import { fetchSleeperGsisIds } from "../src/data/sleeper.js";
import {
  joinProjectionsToGsis,
  SLEEPER_WEEKLY_PATH,
  type SleeperProjection,
  type SleeperProjectionRow,
} from "../src/data/sleeperProjections.js";

const POSITIONS = ["QB", "RB", "WR", "TE"];
const LAST_WEEK = 18;
const PAUSE_MS = 400;

function projectionsUrl(season: number, week: number): string {
  const positions = POSITIONS.map((p) => `position[]=${p}`).join("&");
  return `https://api.sleeper.com/projections/nfl/${season}/${week}?season_type=regular&${positions}`;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWeek(
  season: number,
  week: number,
): Promise<SleeperProjectionRow[]> {
  const response = await fetch(projectionsUrl(season, week));

  if (!response.ok) {
    throw new Error(
      `sleeper projections ${season} week ${week} returned ${response.status}`,
    );
  }

  return (await response.json()) as SleeperProjectionRow[];
}

function parseSeasons(arg: string | undefined): number[] {
  if (!arg) {
    return [2024, 2025, 2026];
  }

  return arg.split(",").map(Number);
}

function toCsv(rows: SleeperProjection[]): string {
  const header = "season,week,gsisId,position,points,targets,carries";
  const lines = rows.map(
    (r) =>
      `${r.season},${r.week},${r.gsisId},${r.position},${r.points},${r.targets},${r.carries}`,
  );

  return [header, ...lines].join("\n") + "\n";
}

async function main(): Promise<void> {
  const flag = process.argv.indexOf("--seasons");
  const seasons = parseSeasons(flag === -1 ? undefined : process.argv[flag + 1]);
  const gsisBySleeperId = await fetchSleeperGsisIds();
  console.log(`${gsisBySleeperId.size} sleeper players have a gsis id`);

  const all: SleeperProjection[] = [];

  for (const season of seasons) {
    let seasonRows = 0;

    for (let week = 1; week <= LAST_WEEK; week++) {
      const raw = await fetchWeek(season, week);
      await pause(PAUSE_MS);

      if (raw.length === 0) {
        console.log(`${season} week ${week}: nothing yet, stopping`);
        break;
      }

      const joined = joinProjectionsToGsis(season, week, raw, gsisBySleeperId);
      all.push(...joined);
      seasonRows += joined.length;
      console.log(
        `${season} week ${week}: ${joined.length} of ${raw.length} rows joined`,
      );
    }

    console.log(`${season}: ${seasonRows} rows`);
  }

  await writeFile(SLEEPER_WEEKLY_PATH, toCsv(all));
  console.log(`wrote ${all.length} rows`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
