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
import { comingWeek, currentSeason, loadGames } from "../src/data/nflverse.js";
import {
  joinProjectionsToGsis,
  loadSleeperWeekly,
  projectionKey,
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

    /**
     * Sleeper revises every week still to come, so fetching all eighteen
     * rewrites thousands of rows a run for numbers nobody reads until
     * that week arrives. Past seasons are settled and come whole.
     */
    const last = season === currentSeason()
      ? Math.min(LAST_WEEK, comingWeek(await loadGames(), season))
      : LAST_WEEK;

    for (let week = 1; week <= last; week++) {
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

  /**
   * A week that was fetched before and is not being fetched now stays.
   * Sleeper stops answering for a season once it is well past, so asking
   * for this season alone and writing only that would throw away every
   * season the bench trains on.
   */
  const kept = new Map(await loadSleeperWeekly());

  for (const row of all) {
    kept.set(projectionKey(row.season, row.week, row.gsisId), row);
  }

  const merged = [...kept.values()].sort(
    (a, b) =>
      a.season - b.season ||
      a.week - b.week ||
      a.gsisId.localeCompare(b.gsisId),
  );
  await writeFile(SLEEPER_WEEKLY_PATH, toCsv(merged));
  console.log(`fetched ${all.length} rows, wrote ${merged.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
