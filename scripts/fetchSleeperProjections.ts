/**
 * Downloads Sleeper's weekly projections into sleeperWeekly.csv, keyed by
 * gsis id, the defences into sleeperDefenceWeekly.csv, and the players who
 * match but have no points into sleeperQuiet.csv. It also writes every
 * player's injury status today to sleeperStatus.csv, for the week the site
 * is about to be built for, whatever seasons were asked for. All four are
 * in data/curated, whose README says what each one is for.
 *
 * The endpoint needs no auth, so the only politeness is going one week at a
 * time with a pause between calls. A week nobody has projected yet comes
 * back empty, which is how a season still to start stops itself.
 *
 * Run: npx tsx scripts/fetchSleeperProjections.ts [--seasons 2024,2025,2026]
 */

import { fetchWithRetry } from "../src/data/fetchWithRetry.js";
import {
  loadSleeperStatus, sameSleeperStatus, SLEEPER_STATUS_PATH,
  sleeperStatusToCsv, teamsAlreadyPlayed, type SleeperStatus,
} from "../src/data/injuries.js";
import {
  canonicalTeam, comingWeek, currentSeason, loadGames,
} from "../src/data/nflverse.js";
import {
  fetchSleeperGsisIds, fetchSleeperInjuryStatuses,
} from "../src/data/sleeper.js";
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

/**
 * The week comes from the same schedule reading the site build uses, so
 * the snapshot is for the week the build shows. The file is left alone
 * when nobody's status moved, so a quiet day commits nothing.
 */
async function saveInjuryStatuses(): Promise<void> {
  const season = currentSeason();
  const games = await loadGames();
  const week = comingWeek(games, season);
  const fetchedAt = new Date().toISOString();
  const played = teamsAlreadyPlayed(games, season, week, fetchedAt.slice(0, 10));
  const rows: SleeperStatus[] = [...await fetchSleeperInjuryStatuses()]
    .filter(([, { team }]) => !played.has(canonicalTeam(team)))
    .map(([gsisId, { status, team }]) =>
      ({ season, week, gsisId, team, status, fetchedAt }));

  if (sameSleeperStatus(await loadSleeperStatus(), rows)) {
    console.log(`${season} week ${week}: no injury status has moved`);
    return;
  }

  await writeAtomically(SLEEPER_STATUS_PATH, sleeperStatusToCsv(rows));
  console.log(
    `${season} week ${week}: ${rows.length} players have an injury status`,
  );
}

async function main(): Promise<void> {
  const flag = process.argv.indexOf("--seasons");
  const seasons = parseSeasons(flag === -1 ? undefined : process.argv[flag + 1]);
  // this downloads the player file again, so it goes before the
  // crosswalk below and that reads the fresh copy
  await saveInjuryStatuses();
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
