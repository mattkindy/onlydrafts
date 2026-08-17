/**
 * One row per drive: who had it, where it started, and how it ended.
 *
 * Matching how often drives end in a touchdown says nothing about
 * whether we can tell which drive will. That needs the drives
 * themselves, with the field position each one actually started from.
 *
 * Run: npx tsx scripts/aggregateDrives.ts
 */

import { createReadStream, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { RAW_DIR } from "../src/data/nflverse.js";
import { splitLine } from "../src/data/csv.js";

const SEASONS = [2022, 2023, 2024, 2025];
const OUT = join(RAW_DIR, "..", "curated", "drives.csv");

/** the yard line as the release writes it, "KC 32", as yards to go */
function toGoal(text: string, offense: string): number {
  const [side, yard] = text.trim().split(/\s+/);
  const number = Number(yard);

  if (!Number.isFinite(number)) {
    return NaN;
  }

  return side === offense ? 100 - number : number;
}

async function main(): Promise<void> {
  const rows: string[] = [
    "season,week,offense,defense,startYard,result,points,plays,firstDowns",
  ];

  for (const season of SEASONS) {
    const path = join(RAW_DIR, `play_by_play_${season}.csv`);

    if (!existsSync(path)) {
      continue;
    }

    const reader = createInterface({ input: createReadStream(path) });
    let header: string[] | undefined;
    const at: Record<string, number> = {};
    const seen = new Set<string>();
    let written = 0;

    for await (const line of reader) {
      if (!header) {
        header = splitLine(line);
        for (const field of [
          "game_id", "week", "posteam", "defteam", "fixed_drive",
          "fixed_drive_result", "drive_start_yard_line", "drive_play_count",
          "drive_first_downs",
        ]) {
          at[field] = header.indexOf(field);
        }
        continue;
      }

      const c = splitLine(line);
      const offense = c[at["posteam"]!] ?? "";
      const drive = c[at["fixed_drive"]!] ?? "";
      const key = `${c[at["game_id"]!]}|${drive}|${offense}`;

      if (!offense || !drive || seen.has(key)) {
        continue;
      }

      const result = c[at["fixed_drive_result"]!] ?? "";
      const startYard = toGoal(c[at["drive_start_yard_line"]!] ?? "", offense);

      if (!result || !Number.isFinite(startYard)) {
        continue;
      }

      seen.add(key);
      const points = result === "Touchdown" ? 7 : result === "Field goal" ? 3 : 0;
      rows.push([
        season, c[at["week"]!], offense, c[at["defteam"]!], startYard,
        result.replace(/,/g, ""), points,
        c[at["drive_play_count"]!] || 0, c[at["drive_first_downs"]!] || 0,
      ].join(","));
      written++;
    }

    console.log(`${season}: ${written} drives`);
  }

  await writeFile(OUT, rows.join("\n") + "\n");
  console.log(`wrote ${rows.length - 1} drives`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
