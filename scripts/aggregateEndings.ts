/**
 * The four things that end a drive without the offence choosing to,
 * pulled out of the play by play so they can be fitted rather than
 * guessed.
 *
 * A kick's chance of going over, how a drive that runs out of time
 * ends, and how often a play is given away. All three are flat numbers
 * in the walk while everything around them reads the state.
 *
 * Run: npx tsx scripts/aggregateEndings.ts
 */

import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { RAW_DIR } from "../src/data/nflverse.js";
import { splitLine } from "../src/data/csv.js";

const SEASONS = [2021, 2022, 2023, 2024, 2025];
const OUT = join(RAW_DIR, "..", "curated", "endings.csv");

async function main(): Promise<void> {
  const out = createWriteStream(OUT);
  out.write("season,kind,yardline,togo,down,call,length,made\n");
  let total = 0;

  for (const season of SEASONS) {
    const path = join(RAW_DIR, `play_by_play_${season}.csv`);

    if (!existsSync(path)) {
      continue;
    }

    const reader = createInterface({ input: createReadStream(path) });
    let header: string[] | undefined;
    const at: Record<string, number> = {};
    let written = 0;

    for await (const line of reader) {
      if (!header) {
        header = splitLine(line);
        for (const field of [
          "play_type", "field_goal_result", "kick_distance", "yardline_100",
          "down", "ydstogo", "interception", "fumble_lost",
          "fixed_drive_result", "drive_play_count", "game_id", "fixed_drive",
        ]) {
          at[field] = header.indexOf(field);
        }
        continue;
      }

      const c = splitLine(line);
      const type = c[at["play_type"]!] ?? "";
      const yardline = Number(c[at["yardline_100"]!]);

      if (type === "field_goal" && Number.isFinite(yardline)) {
        out.write([
          season, "kick", yardline, 0, 0, "",
          c[at["kick_distance"]!] || 0,
          c[at["field_goal_result"]!] === "made" ? 1 : 0,
        ].join(",") + "\n");
        written++;
        continue;
      }

      if (!["run", "pass"].includes(type) || !Number.isFinite(yardline)) {
        continue;
      }

      const lost = c[at["interception"]!] === "1" ||
        c[at["fumble_lost"]!] === "1" ? 1 : 0;
      out.write([
        season, "play", yardline, c[at["ydstogo"]!] || 0, c[at["down"]!] || 0,
        type, 0, lost,
      ].join(",") + "\n");
      written++;
    }

    total += written;
    console.log(`${season}: ${written} rows`);
  }

  await new Promise((done) => out.end(done));
  console.log(`wrote ${total} rows`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
