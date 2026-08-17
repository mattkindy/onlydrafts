/**
 * Streams the participation files and writes one row per matchup:
 * which offence faced which front, how many drop-backs, how many of
 * them were pressured, and how many men the defence kept in the box.
 *
 * Run: npx tsx scripts/aggregatePressure.ts
 */

import { createReadStream, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { RAW_DIR } from "../src/data/nflverse.js";
import { splitLine } from "../src/data/csv.js";

const SEASONS = [2022, 2023, 2024, 2025];
const OUT = join(RAW_DIR, "..", "curated", "pressureMatchups.csv");

/** splits one csv line, honoring double quotes */

interface Tally {
  dropbacks: number;
  pressures: number;
  rushers: number;
  box: number;
  boxPlays: number;
}

async function main(): Promise<void> {
  const rows: string[] = [
    "season,week,offense,defense,dropbacks,pressures,rushers,box",
  ];

  for (const season of SEASONS) {
    const path = join(RAW_DIR, `participation_${season}.csv`);

    if (!existsSync(path)) {
      console.warn(`no participation file for ${season}`);
      continue;
    }

    const tallies = new Map<string, Tally>();
    const reader = createInterface({ input: createReadStream(path) });
    let header: string[] | undefined;
    let iGame = -1, iPoss = -1, iPressure = -1, iRushers = -1, iBox = -1;

    for await (const line of reader) {
      if (!header) {
        header = splitLine(line);
        iGame = header.indexOf("nflverse_game_id");
        iPoss = header.indexOf("possession_team");
        iPressure = header.indexOf("was_pressure");
        iRushers = header.indexOf("number_of_pass_rushers");
        iBox = header.indexOf("defenders_in_box");
        continue;
      }

      const cells = splitLine(line);
      const gameId = cells[iGame] ?? "";
      const offense = cells[iPoss] ?? "";
      // game ids read season_week_away_home
      const parts = gameId.split("_");

      if (parts.length < 4 || !offense) {
        continue;
      }

      const week = Number(parts[1]);
      const defense = parts[2] === offense ? parts[3]! : parts[2]!;
      const key = `${week}|${offense}|${defense}`;
      const tally = tallies.get(key) ??
        { dropbacks: 0, pressures: 0, rushers: 0, box: 0, boxPlays: 0 };

      const pressure = cells[iPressure];
      const rushers = Number(cells[iRushers]);
      const box = Number(cells[iBox]);

      if (pressure === "TRUE" || pressure === "FALSE") {
        tally.dropbacks++;
        if (pressure === "TRUE") tally.pressures++;
        if (Number.isFinite(rushers)) tally.rushers += rushers;
      }

      if (Number.isFinite(box) && box > 0) {
        tally.box += box;
        tally.boxPlays++;
      }

      tallies.set(key, tally);
    }

    for (const [key, t] of tallies) {
      if (t.dropbacks < 10) continue;
      const [week, offense, defense] = key.split("|");
      rows.push([
        season, week, offense, defense, t.dropbacks, t.pressures,
        (t.rushers / t.dropbacks).toFixed(2),
        t.boxPlays > 0 ? (t.box / t.boxPlays).toFixed(2) : "",
      ].join(","));
    }

    console.log(`${season}: ${tallies.size} matchups`);
  }

  await writeFile(OUT, rows.join("\n") + "\n");
  console.log(`wrote ${rows.length - 1} rows to ${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
