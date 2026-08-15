// Downloads nflverse flat files (games, weekly player stats) into
// data/raw/, skipping files already on disk. Run with:
//   npx tsx scripts/fetchData.ts --seasons 2021-2025

import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";

const RAW_DIR = join(import.meta.dirname, "..", "data", "raw");

const GAMES_URL =
  "https://github.com/nflverse/nfldata/raw/master/data/games.csv";

function playerStatsUrl(season: number): string {
  return `https://github.com/nflverse/nflverse-data/releases/download/player_stats/player_stats_${season}.csv`;
}

function weeklyRosterUrl(season: number): string {
  return `https://github.com/nflverse/nflverse-data/releases/download/weekly_rosters/roster_weekly_${season}.csv`;
}

function snapCountsUrl(season: number): string {
  return `https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_${season}.csv`;
}

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

async function download(url: string, fileName: string): Promise<void> {
  const path = join(RAW_DIR, fileName);

  if (await exists(path)) {
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

async function main(): Promise<void> {
  const seasonsFlag = process.argv.indexOf("--seasons");
  const seasons = parseSeasons(
    seasonsFlag === -1 ? undefined : process.argv[seasonsFlag + 1],
  );

  await mkdir(RAW_DIR, { recursive: true });
  await download(GAMES_URL, "games.csv");

  for (const season of seasons) {
    await download(playerStatsUrl(season), `player_stats_${season}.csv`);
    await download(weeklyRosterUrl(season), `roster_weekly_${season}.csv`);
    await download(snapCountsUrl(season), `snap_counts_${season}.csv`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
