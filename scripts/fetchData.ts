// Downloads nflverse flat files into data/raw/, skipping files
// already on disk unless --force. In-season refresh:
//   npx tsx scripts/fetchData.ts --seasons 2026 --force

import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";

const RAW_DIR = join(import.meta.dirname, "..", "data", "raw");

/** the participation release starts here; earlier seasons have none */
const FIRST_PARTICIPATION_SEASON = 2022;

const GAMES_URL =
  "https://github.com/nflverse/nfldata/raw/master/data/games.csv";

function playerStatsUrl(season: number): string {
  return `https://github.com/nflverse/nflverse-data/releases/download/player_stats/player_stats_${season}.csv`;
}

/** nflverse renamed the weekly stats release after the 2024 season */
function renamedStatsUrl(season: number): string {
  return `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv`;
}

function weeklyRosterUrl(season: number): string {
  return `https://github.com/nflverse/nflverse-data/releases/download/weekly_rosters/roster_weekly_${season}.csv`;
}

function snapCountsUrl(season: number): string {
  return `https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_${season}.csv`;
}

/**
 * Formation, personnel, route and coverage, one row per play. A
 * separate release from the play-by-play, and it only goes back to
 * 2022, so callers have to cope with older seasons missing it.
 */
function participationUrl(season: number): string {
  return `https://github.com/nflverse/nflverse-data/releases/download/pbp_participation/pbp_participation_${season}.csv`;
}

/**
 * What a player is, rather than what he did. Height, weight, where he
 * was drafted and what he ran at the combine do not change from week
 * to week, so they come as one file each rather than per season.
 */
const PLAYER_FILES: [url: string, name: string][] = [
  [
    "https://github.com/nflverse/nflverse-data/releases/download/combine/combine.csv",
    "combine.csv",
  ],
  [
    "https://github.com/nflverse/nflverse-data/releases/download/draft_picks/draft_picks.csv",
    "draft_picks.csv",
  ],
  /**
   * What a passer did, in the parts a throw is made of: how far he
   * meant it to go, how far it went when it was caught, how much of
   * that was the receiver afterwards, and how often he was on target.
   * The carrying and catching files have been here for a while and
   * this is the third of the set, without which nothing can see a
   * quarterback except by the points he ended up with.
   */
  [
    "https://github.com/nflverse/nflverse-data/releases/download/pfr_advstats/advstats_season_pass.csv",
    "advstats_pass.csv",
  ],
];

function parseSeasons(arg: string | undefined): number[] {
  if (!arg) {
    return [2021, 2022, 2023, 2024, 2025];
  }

  const range = arg.match(/^(\d{4})-(\d{4})$/);

  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }

  return arg.split(",").map(Number);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const force = process.argv.includes("--force");

async function download(url: string, fileName: string): Promise<void> {
  const path = join(RAW_DIR, fileName);

  if (!force && (await exists(path))) {
    console.log(`skip ${fileName} (already downloaded)`);
    return;
  }

  const response = await fetch(url, { redirect: "follow" });

  if (!response.ok) {
    throw new Error(`GET ${url} returned ${response.status}`);
  }

  await writeFile(path, Buffer.from(await response.arrayBuffer()));
  console.log(`saved ${fileName}`);
}

// nflverse renames and retires releases, so one missing file should
// not stop the rest of the download
const missing: string[] = [];

async function tryDownload(url: string, fileName: string): Promise<void> {
  try {
    await download(url, fileName);
  } catch (error) {
    missing.push(`${fileName}: ${error instanceof Error ? error.message : error}`);
  }
}

async function main(): Promise<void> {
  const seasonsFlag = process.argv.indexOf("--seasons");
  const seasons = parseSeasons(
    seasonsFlag === -1 ? undefined : process.argv[seasonsFlag + 1],
  );

  await mkdir(RAW_DIR, { recursive: true });
  await download(GAMES_URL, "games.csv");

  for (const [url, name] of PLAYER_FILES) {
    await tryDownload(url, name);
  }

  for (const season of seasons) {
    await tryDownload(playerStatsUrl(season), `player_stats_${season}.csv`);
    await tryDownload(renamedStatsUrl(season), `stats_player_week_${season}.csv`);
    await tryDownload(weeklyRosterUrl(season), `roster_weekly_${season}.csv`);
    await tryDownload(snapCountsUrl(season), `snap_counts_${season}.csv`);

    if (season >= FIRST_PARTICIPATION_SEASON) {
      await tryDownload(participationUrl(season), `participation_${season}.csv`);
    }
  }

  if (missing.length > 0) {
    console.warn(`\n${missing.length} files were not available:`);
    for (const line of missing) console.warn("  " + line);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
