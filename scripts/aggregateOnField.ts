/**
 * One row per play with the twenty two men who were on the field.
 *
 * plays.csv says what the two sides lined up in, as a grouping and a
 * shell. That is enough to ask what 11 personnel gains and not enough
 * to ask what happens when this receiver faces that corner, because
 * by then we no longer know which players those were.
 *
 * The file is written to the raw directory because it runs to tens of
 * megabytes and can be rebuilt from the releases at any time.
 *
 * Run: npx tsx scripts/aggregateOnField.ts
 */

import { createReadStream, existsSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { RAW_DIR } from "../src/data/nflverse.js";
import { splitLine } from "../src/data/csv.js";

const SEASONS = [2022, 2023, 2024, 2025];
const OUT = join(RAW_DIR, "onField.csv");

async function playersFor(season: number) {
  const path = join(RAW_DIR, `participation_${season}.csv`);
  const byPlay = new Map<string, { offence: string; defence: string }>();

  if (!existsSync(path)) {
    return byPlay;
  }

  const reader = createInterface({ input: createReadStream(path) });
  let header: string[] | undefined;
  let iGame = -1, iPlay = -1, iOff = -1, iDef = -1;

  for await (const line of reader) {
    if (!header) {
      header = splitLine(line);
      iGame = header.indexOf("nflverse_game_id");
      iPlay = header.indexOf("play_id");
      iOff = header.indexOf("offense_players");
      iDef = header.indexOf("defense_players");
      continue;
    }

    const c = splitLine(line);
    const offence = c[iOff] ?? "";

    if (!offence) {
      continue;
    }

    byPlay.set(`${c[iGame]}|${c[iPlay]}`, { offence, defence: c[iDef] ?? "" });
  }

  return byPlay;
}

async function main(): Promise<void> {
  const out = createWriteStream(OUT);
  out.write(
    "season,week,offense,defense,down,togo,yardline,margin,playType,yards," +
      "offenceOn,defenceOn\n",
  );
  let total = 0;

  for (const season of SEASONS) {
    const pbp = join(RAW_DIR, `play_by_play_${season}.csv`);

    if (!existsSync(pbp)) {
      continue;
    }

    const onField = await playersFor(season);
    const reader = createInterface({ input: createReadStream(pbp) });
    let header: string[] | undefined;
    const at: Record<string, number> = {};
    let written = 0;

    for await (const line of reader) {
      if (!header) {
        header = splitLine(line);
        for (const field of [
          "game_id", "play_id", "week", "posteam", "defteam", "down",
          "ydstogo", "yardline_100", "score_differential", "play_type",
          "yards_gained",
        ]) {
          at[field] = header.indexOf(field);
        }
        continue;
      }

      const c = splitLine(line);
      const type = c[at["play_type"]!] ?? "";

      if (!["run", "pass"].includes(type)) {
        continue;
      }

      const found = onField.get(`${c[at["game_id"]!]}|${c[at["play_id"]!]}`);
      const down = Number(c[at["down"]!]);
      const yardline = Number(c[at["yardline_100"]!]);

      if (!found || !Number.isFinite(down) || !Number.isFinite(yardline)) {
        continue;
      }

      out.write([
        season, c[at["week"]!], c[at["posteam"]!], c[at["defteam"]!],
        down, c[at["ydstogo"]!], yardline, c[at["score_differential"]!] || 0,
        type, c[at["yards_gained"]!] || 0,
        found.offence, found.defence,
      ].join(",") + "\n");
      written++;
    }

    total += written;
    console.log(`${season}: ${written} plays with both sides listed`);
  }

  await new Promise((done) => out.end(done));
  console.log(`wrote ${total} rows to ${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
