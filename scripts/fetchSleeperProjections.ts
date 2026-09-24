/**
 * Downloads Sleeper's weekly projections and writes them to
 * data/curated/sleeperWeekly.csv, one row per player-week, keyed by gsis id.
 * The defences come down in the same call and go to
 * data/curated/sleeperDefenceWeekly.csv, keyed by team abbreviation. A
 * player who matches a gsis id but has no points goes to
 * data/curated/sleeperQuiet.csv.
 *
 * The endpoint needs no auth, so the only politeness is going one week at a
 * time with a pause between calls. A week nobody has projected yet comes
 * back empty, which is how a season still to start stops itself. Every week
 * is fetched, not only the one coming up, because the player card shows a
 * line for each week ahead.
 *
 * Run: npx tsx scripts/fetchSleeperProjections.ts [--seasons 2024,2025,2026]
 */

import { fetchWithRetry } from "../src/data/fetchWithRetry.js";
import { fetchSleeperGsisIds } from "../src/data/sleeper.js";
import { writeAtomically } from "../src/data/writeAtomically.js";
import {
  defenceProjectionsToCsv,
  joinDefenceProjections,
  joinProjectionsToGsis,
  loadSleeperDefences,
  loadSleeperQuiet,
  loadSleeperWeekly,
  projectionsToCsv,
  quietFromKey,
  quietToCsv,
  replaceFetchedWeeks,
  SLEEPER_DEFENCE_PATH,
  SLEEPER_QUIET_PATH,
  SLEEPER_WEEKLY_PATH,
  weekKey,
  type SleeperDefence,
  type SleeperProjection,
  type SleeperProjectionRow,
  type SleeperQuiet,
} from "../src/data/sleeperProjections.js";

const POSITIONS = ["QB", "RB", "WR", "TE", "DEF"];
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
  const response = await fetchWithRetry(projectionsUrl(season, week), {
    label: `sleeper projections ${season} week ${week}`,
  });

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

async function main(): Promise<void> {
  const flag = process.argv.indexOf("--seasons");
  const seasons = parseSeasons(flag === -1 ? undefined : process.argv[flag + 1]);
  const gsisBySleeperId = await fetchSleeperGsisIds();
  console.log(`${gsisBySleeperId.size} sleeper players have a gsis id`);

  const all: SleeperProjection[] = [];
  const quiet: SleeperQuiet[] = [];
  const defences: SleeperDefence[] = [];
  const fetchedWeeks = new Set<string>();

  for (const season of seasons) {
    let seasonRows = 0;

    for (let week = 1; week <= LAST_WEEK; week++) {
      const raw = await fetchWeek(season, week);
      await pause(PAUSE_MS);

      if (raw.length === 0) {
        console.log(`${season} week ${week}: nothing yet, stopping`);
        break;
      }

      fetchedWeeks.add(weekKey(season, week));
      const defenceRaw = raw.filter((r) => r.player?.position === "DEF");
      const joined = joinProjectionsToGsis(
        season, week, raw.filter((r) => r.player?.position !== "DEF"),
        gsisBySleeperId,
      );
      all.push(...joined.projected);
      quiet.push(...joined.quiet);
      defences.push(...joinDefenceProjections(season, week, defenceRaw));
      seasonRows += joined.projected.length;
      console.log(
        `${season} week ${week}: ${joined.projected.length} of ${raw.length} ` +
        `rows joined, ${joined.quiet.length} matched with no points, ` +
        `${defenceRaw.length} defences`,
      );
    }

    console.log(`${season}: ${seasonRows} rows`);
  }

  // each of the three files has the weeks fetched now rewritten whole
  // and every other week left as it was
  const weekly = replaceFetchedWeeks(
    (await loadSleeperWeekly()).values(), all, fetchedWeeks,
  );
  await writeAtomically(SLEEPER_WEEKLY_PATH, projectionsToCsv(weekly));
  console.log(`fetched ${all.length} rows, wrote ${weekly.length}`);

  const allQuiet = replaceFetchedWeeks(
    [...await loadSleeperQuiet()].map(quietFromKey), quiet, fetchedWeeks,
  );
  await writeAtomically(SLEEPER_QUIET_PATH, quietToCsv(allQuiet));
  console.log(
    `fetched ${quiet.length} rows with no points, wrote ${allQuiet.length}`,
  );

  const allDefences = replaceFetchedWeeks(
    (await loadSleeperDefences()).values(), defences, fetchedWeeks,
  );
  await writeAtomically(
    SLEEPER_DEFENCE_PATH, defenceProjectionsToCsv(allDefences),
  );
  console.log(
    `fetched ${defences.length} defence weeks, wrote ${allDefences.length}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
