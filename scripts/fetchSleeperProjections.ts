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
 * back empty, which is how the current season stops itself.
 *
 * Run: npx tsx scripts/fetchSleeperProjections.ts [--seasons 2024,2025,2026]
 */

import { writeFile } from "node:fs/promises";
import { fetchSleeperGsisIds } from "../src/data/sleeper.js";
import { comingWeek, currentSeason, loadGames } from "../src/data/nflverse.js";
import {
  defenceProjectionsToCsv,
  joinDefenceProjections,
  joinProjectionsToGsis,
  loadSleeperDefences,
  loadSleeperQuiet,
  loadSleeperWeekly,
  projectionKey,
  quietToCsv,
  SLEEPER_DEFENCE_PATH,
  SLEEPER_QUIET_PATH,
  SLEEPER_WEEKLY_PATH,
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
  const header = "season,week,gsisId,position,points,targets,carries,catches";
  const lines = rows.map(
    (r) =>
      `${r.season},${r.week},${r.gsisId},${r.position},${r.points},` +
      `${r.targets},${r.carries},${r.catches ?? ""}`,
  );

  return [header, ...lines].join("\n") + "\n";
}

async function main(): Promise<void> {
  const flag = process.argv.indexOf("--seasons");
  const seasons = parseSeasons(flag === -1 ? undefined : process.argv[flag + 1]);
  const gsisBySleeperId = await fetchSleeperGsisIds();
  console.log(`${gsisBySleeperId.size} sleeper players have a gsis id`);

  const all: SleeperProjection[] = [];
  const quiet: SleeperQuiet[] = [];
  const defences: SleeperDefence[] = [];

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

  /**
   * A man who was quiet last run and has a number now must leave the
   * file, so the weeks fetched this run are rewritten whole rather than
   * merged key by key. Other weeks stay for the same reason as above.
   */
  const fetchedWeeks = new Set(
    [...all, ...quiet].map((row) => `${row.season}|${row.week}`),
  );
  const keptQuiet = [...await loadSleeperQuiet()]
    .map((key) => key.split("|"))
    .filter(([season, week]) => !fetchedWeeks.has(`${season}|${week}`))
    .map(([season, week, gsisId]): SleeperQuiet => ({
      season: Number(season), week: Number(week), gsisId: gsisId ?? "",
    }));
  const allQuiet = [...keptQuiet, ...quiet];
  await writeFile(SLEEPER_QUIET_PATH, quietToCsv(allQuiet));
  console.log(
    `fetched ${quiet.length} rows with no points, wrote ${allQuiet.length}`,
  );

  const keptDefences = new Map(await loadSleeperDefences());

  for (const row of defences) {
    keptDefences.set(projectionKey(row.season, row.week, row.team), row);
  }

  await writeFile(
    SLEEPER_DEFENCE_PATH, defenceProjectionsToCsv([...keptDefences.values()]),
  );
  console.log(
    `fetched ${defences.length} defence weeks, wrote ${keptDefences.size}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
