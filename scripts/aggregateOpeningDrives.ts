/**
 * One row per opening drive of a half, 2022 to 2025.
 *
 * The first drive of each half is the one state a simulator can be put
 * into without argument: the field position is known, the clock is
 * fresh, and nobody is trailing by three scores and throwing on every
 * down. Everything a walk of that drive can be scored against is here,
 * so the eval does not have to read the play by play again.
 *
 * Run: npx tsx scripts/aggregateOpeningDrives.ts
 */

import { createReadStream, existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { RAW_DIR } from "../src/data/nflverse.js";
import { parseCsv, splitLine } from "../src/data/csv.js";

const SEASONS = [2022, 2023, 2024, 2025];
const OUT = join(RAW_DIR, "..", "curated", "openingDrives.csv");

const FIELDS = [
  "game_id", "week", "posteam", "defteam", "qtr", "fixed_drive",
  "fixed_drive_result", "play_type", "yards_gained", "yardline_100",
] as const;

interface Drive {
  gameId: string;
  week: string;
  offense: string;
  defense: string;
  half: number;
  drive: number;
  startYard: number;
  result: string;
  plays: number;
  endYard: number;
  firstCall: string;
  firstYards: number;
}

/** the betting lines, by game, so a fitted rival has something to use */
async function loadLines(): Promise<Map<string, { spread: number; total: number }>> {
  const lines = new Map<string, { spread: number; total: number }>();

  for (const row of parseCsv(await readFile(join(RAW_DIR, "games.csv"), "utf8"))) {
    const spread = Number(row["spread_line"]);
    const total = Number(row["total_line"]);

    if (!Number.isFinite(spread) || !Number.isFinite(total)) {
      continue;
    }

    lines.set(row["game_id"] ?? "", { spread, total });
  }

  return lines;
}

async function homeTeams(): Promise<Map<string, string>> {
  const home = new Map<string, string>();

  for (const row of parseCsv(await readFile(join(RAW_DIR, "games.csv"), "utf8"))) {
    home.set(row["game_id"] ?? "", row["home_team"] ?? "");
  }

  return home;
}

async function drivesIn(season: number): Promise<Drive[]> {
  const path = join(RAW_DIR, `play_by_play_${season}.csv`);

  if (!existsSync(path)) {
    return [];
  }

  const reader = createInterface({ input: createReadStream(path) });
  let header: string[] | undefined;
  const at: Record<string, number> = {};
  // the first drive of each half of each game, and only that one
  const opening = new Map<string, Drive>();

  for await (const line of reader) {
    if (!header) {
      header = splitLine(line);
      for (const field of FIELDS) {
        at[field] = header.indexOf(field);
      }
      continue;
    }

    const c = splitLine(line);
    const call = c[at["play_type"]!] ?? "";

    if (call !== "run" && call !== "pass") {
      continue;
    }

    const quarter = Number(c[at["qtr"]!]);
    const offense = c[at["posteam"]!] ?? "";
    const drive = Number(c[at["fixed_drive"]!]);
    const spot = Number(c[at["yardline_100"]!]);
    const gained = Number(c[at["yards_gained"]!]);

    if (!offense || quarter > 4 || !Number.isFinite(drive) ||
      !Number.isFinite(spot) || !Number.isFinite(gained)) {
      continue;
    }

    const half = quarter <= 2 ? 1 : 2;
    const key = `${c[at["game_id"]!]}|${half}`;
    const seen = opening.get(key);

    if (seen && seen.drive !== drive) {
      // a later drive in the same half, so the opening one is already done
      if (drive > seen.drive) {
        continue;
      }
    }

    if (!seen || drive < seen.drive) {
      opening.set(key, {
        gameId: c[at["game_id"]!] ?? "",
        week: c[at["week"]!] ?? "",
        offense,
        defense: c[at["defteam"]!] ?? "",
        half,
        drive,
        startYard: spot,
        result: (c[at["fixed_drive_result"]!] ?? "").replace(/,/g, ""),
        plays: 1,
        endYard: spot - gained,
        firstCall: call,
        firstYards: gained,
      });
      continue;
    }

    seen.plays++;
    seen.endYard = spot - gained;
  }

  return [...opening.values()];
}

async function main(): Promise<void> {
  const lines = await loadLines();
  const home = await homeTeams();
  const rows: string[] = [
    "season,week,gameId,offense,defense,half,startYard,result,plays,netYards," +
      "firstCall,firstYards,spread,total",
  ];

  for (const season of SEASONS) {
    const drives = await drivesIn(season);

    for (const drive of drives) {
      const line = lines.get(drive.gameId);

      if (!line || !drive.result) {
        continue;
      }

      // the spread as this offence sees it, positive when it is favoured
      const mine = home.get(drive.gameId) === drive.offense
        ? line.spread
        : -line.spread;
      const ended = Math.max(0, Math.min(100, drive.endYard));

      rows.push([
        season, drive.week, drive.gameId, drive.offense, drive.defense,
        drive.half, drive.startYard, drive.result, drive.plays,
        drive.startYard - ended, drive.firstCall, drive.firstYards,
        mine, line.total,
      ].join(","));
    }

    console.log(`${season}: ${drives.length} opening drives`);
  }

  await writeFile(OUT, rows.join("\n") + "\n");
  console.log(`wrote ${rows.length - 1} drives`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
