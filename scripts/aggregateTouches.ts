/**
 * One row per play with the state it was run from and who got the ball.
 *
 * Everything downstream cuts the field into four situations and takes
 * an average inside each. That throws away the difference between
 * third and one and third and nine, and between the two yard line and
 * the eighteen. The state is on every play, so keep it and let whatever
 * is fitted decide what matters.
 *
 * Run: npx tsx scripts/aggregateTouches.ts
 */

import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { RAW_DIR } from "../src/data/nflverse.js";
import { splitLine } from "../src/data/csv.js";

const SEASONS = [2021, 2022, 2023, 2024, 2025];
const OUT = join(RAW_DIR, "..", "curated", "touches.csv");

/**
 * What the defence showed, from the participation file. Coverage is
 * complete from 2023 and about a third of 2022, so a season without
 * it leaves the columns empty and whatever reads them falls back.
 */
/** how many defensive backs are on, which is the look in one word */
const shellOf = (text: string): string => {
  let backs = 0;

  for (const spot of ["CB", "FS", "SS", "S", "DB"]) {
    backs += Number(new RegExp(`(\\d+) ${spot}(?:,|$)`).exec(text)?.[1] ?? 0);
  }

  if (backs < 4) return "";
  if (backs === 4) return "base";
  if (backs === 5) return "nickel";

  return "dime";
};

async function shownBy(season: number) {
  const path = join(RAW_DIR, `participation_${season}.csv`);
  const byPlay = new Map<string, {
    manZone: string; coverage: string; rushers: number; box: number;
    shell: string;
  }>();

  if (!existsSync(path)) {
    return byPlay;
  }

  const reader = createInterface({ input: createReadStream(path) });
  let header: string[] | undefined;
  const at: Record<string, number> = {};

  for await (const line of reader) {
    if (!header) {
      header = splitLine(line);

      for (const field of [
        "nflverse_game_id", "play_id", "defense_man_zone_type",
        "defense_coverage_type", "number_of_pass_rushers", "defenders_in_box",
        "defense_personnel",
      ]) {
        at[field] = header.indexOf(field);
      }

      continue;
    }

    const c = splitLine(line);
    const man = c[at["defense_man_zone_type"]!] ?? "";
    byPlay.set(`${c[at["nflverse_game_id"]!]}|${c[at["play_id"]!]}`, {
      manZone: man === "MAN_COVERAGE" ? "man" : man === "ZONE_COVERAGE" ? "zone" : "",
      coverage: (c[at["defense_coverage_type"]!] ?? "").toLowerCase(),
      rushers: Number(c[at["number_of_pass_rushers"]!]) || 0,
      box: Number(c[at["defenders_in_box"]!]) || 0,
      shell: shellOf(c[at["defense_personnel"]!] ?? ""),
    });
  }

  return byPlay;
}

async function main(): Promise<void> {
  const out = createWriteStream(OUT);
  out.write(
    "season,week,offense,defense,down,togo,yardline,margin,seconds," +
      "playType,player,passer,airYards,caught,yards,touchdown,shotgun," +
      "manZone,coverage,rushers,shell,box\n",
  );
  let total = 0;

  for (const season of SEASONS) {
    const path = join(RAW_DIR, `play_by_play_${season}.csv`);

    if (!existsSync(path)) {
      continue;
    }

    const defenceShowed = await shownBy(season);

    const reader = createInterface({ input: createReadStream(path) });
    let header: string[] | undefined;
    const at: Record<string, number> = {};
    let written = 0;

    for await (const line of reader) {
      if (!header) {
        header = splitLine(line);
        for (const field of [
          "week", "posteam", "defteam", "down", "ydstogo", "yardline_100",
          "score_differential", "game_seconds_remaining", "play_type",
          "yards_gained", "touchdown", "rusher_player_id", "receiver_player_id",
          "complete_pass", "passer_player_id", "air_yards", "shotgun",
          "game_id", "play_id",
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

      // The man the ball was meant for, whether or not he caught it,
      // and empty on a sack or a throwaway. Those have to stay: they
      // are 8% of passes and they lose ground, so leaving them out
      // makes every drive gain more than it should.
      const named = type === "run"
        ? c[at["rusher_player_id"]!] ?? ""
        : c[at["receiver_player_id"]!] ?? "";
      const player = named.startsWith("00-") ? named : "";
      // and who threw it, since a receiver's yards are half his
      // quarterback's and the walk could not see one at all
      const threw = c[at["passer_player_id"]!] ?? "";
      const passer = type === "pass" && threw.startsWith("00-") ? threw : "";
      // how far downfield it was thrown, which is chosen before
      // anybody catches it and decides most of what happens next
      const air = Number(c[at["air_yards"]!]);
      const airYards = type === "pass" && Number.isFinite(air) ? air : "";
      // whether anybody caught it, blank on a run
      const caught = type === "pass"
        ? (c[at["complete_pass"]!] === "1" ? 1 : 0) : "";
      const down = Number(c[at["down"]!]);
      const yardline = Number(c[at["yardline_100"]!]);

      if (!Number.isFinite(down) || !Number.isFinite(yardline)) {
        continue;
      }

      const shown = defenceShowed.get(
        `${c[at["game_id"]!]}|${c[at["play_id"]!]}`,
      );

      out.write([
        season, c[at["week"]!], c[at["posteam"]!], c[at["defteam"]!],
        down, c[at["ydstogo"]!], yardline,
        c[at["score_differential"]!] || 0, c[at["game_seconds_remaining"]!] || 0,
        type, player, passer, airYards, caught, c[at["yards_gained"]!] || 0,
        c[at["touchdown"]!] === "1" ? 1 : 0,
        c[at["shotgun"]!] === "1" ? 1 : 0,
        shown?.manZone ?? "",
        shown?.coverage ?? "",
        shown?.rushers || "",
        shown?.shell ?? "",
        shown?.box || "",
      ].join(",") + "\n");
      written++;
    }

    total += written;
    console.log(`${season}: ${written} touches`);
  }

  await new Promise((done) => out.end(done));
  console.log(`wrote ${total} rows to ${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
