/**
 * One row per play with the state it was run from and who got the ball.
 *
 * Everything downstream cuts the field into four situations and takes
 * an average inside each. That throws away the difference between
 * third and one and third and nine, and between the two yard line and
 * the eighteen. The state is on every play, so keep it and let whatever
 * is fitted decide what matters.
 *
 * With no `--seasons` every season from 2021 on is read again, a
 * gigabyte of play files. A weekly refresh asks for the season being
 * played and the rest of the file comes back as it was.
 * Run: npx tsx scripts/aggregateTouches.ts [--seasons 2026]
 */

import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { currentSeason, RAW_DIR } from "../src/data/nflverse.js";
import { seasonsAsked } from "../src/data/seasons.js";
import { mergedTouches, type SeasonRows } from "../src/data/touchesSeasons.js";
import { splitLine } from "../src/data/csv.js";

const FIRST_SEASON = 2021;
/** every season from 2021 to the one being played, so a refresh picks it up */
const SEASONS = Array.from(
  { length: Math.max(1, currentSeason() - FIRST_SEASON + 1) },
  (_, i) => FIRST_SEASON + i,
);
const OUT = join(RAW_DIR, "..", "curated", "touches.csv");
const HEADER =
  "season,week,offense,defense,down,togo,yardline,margin,seconds," +
  "playType,player,passer,airYards,caught,yards,touchdown,shotgun," +
  "manZone,coverage,rushers,shell,box,afterCatch";

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

/** every run and pass of one season, empty when the play file is absent */
async function touchesIn(season: number): Promise<string[]> {
  const path = join(RAW_DIR, `play_by_play_${season}.csv`);

  if (!existsSync(path)) {
    return [];
  }

  const defenceShowed = await shownBy(season);
  const reader = createInterface({ input: createReadStream(path) });
  const rows: string[] = [];
  let header: string[] | undefined;
  const at: Record<string, number> = {};

  for await (const line of reader) {
    if (!header) {
      header = splitLine(line);
      for (const field of [
        "week", "posteam", "defteam", "down", "ydstogo", "yardline_100",
        "score_differential", "game_seconds_remaining", "play_type",
        "yards_gained", "touchdown", "rusher_player_id", "receiver_player_id",
        "complete_pass", "passer_player_id", "air_yards", "shotgun",
        "game_id", "play_id", "yards_after_catch",
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

    // The man the ball was meant for, whether or not he caught it, and
    // empty on a sack or a throwaway. Those have to stay: they are 8% of
    // passes and lose ground, so without them every drive gains too much.
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
    // and what he made once it was his, which lasts .689 to the next
    // season where his air yards last .884
    const made = Number(c[at["yards_after_catch"]!]);
    const afterCatch = type === "pass" && Number.isFinite(made) ? made : "";
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

    rows.push([
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
      afterCatch,
    ].join(","));
  }

  return rows;
}

/** the rows the file already contains, split by season */
async function alreadyCounted(): Promise<SeasonRows> {
  const bySeason: SeasonRows = new Map();

  if (!existsSync(OUT)) {
    return bySeason;
  }

  const reader = createInterface({ input: createReadStream(OUT) });

  for await (const line of reader) {
    if (line === "" || line.startsWith("season,")) {
      continue;
    }

    const season = Number(line.slice(0, line.indexOf(",")));
    const rows = bySeason.get(season);

    if (rows) {
      rows.push(line);
      continue;
    }

    bySeason.set(season, [line]);
  }

  return bySeason;
}

async function main(): Promise<void> {
  const asked = seasonsAsked(process.argv, SEASONS);
  const onDisk = await alreadyCounted();
  const derived: SeasonRows = new Map();

  for (const season of asked) {
    const rows = await touchesIn(season);
    derived.set(season, rows);
    console.log(`${season}: ${rows.length} touches`);
  }

  const { rows, kept } = mergedTouches({
    seasons: [...SEASONS, ...asked, ...onDisk.keys()],
    asked,
    onDisk,
    derived,
  });

  for (const season of kept) {
    console.log(
      `${season}: no play file, so the ${onDisk.get(season)!.length} rows ` +
        "already counted stand",
    );
  }

  // written aside and moved into place, so a run that dies partway
  // through leaves the file every eval reads as it was
  const part = `${OUT}.part`;
  const out = createWriteStream(part);
  out.write(`${HEADER}\n`);

  for (const row of rows) {
    out.write(`${row}\n`);
  }

  await new Promise((done) => out.end(done));
  await rename(part, OUT);
  console.log(`wrote ${rows.length} rows to ${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
