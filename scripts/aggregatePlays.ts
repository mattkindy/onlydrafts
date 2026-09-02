/**
 * One row per play: the state it was run from, what both sides lined
 * up in, and what came of it.
 *
 * Both of the things being built need this. A model of what personnel
 * a coordinator picks needs the state and the grouping. A drive
 * simulator needs the state, the grouping and the yards, so it can
 * walk from first and ten to whatever happens next.
 *
 * Personnel comes from the participation release and only goes back to
 * 2022; earlier plays are written with the grouping left empty.
 *
 * Run: npx tsx scripts/aggregatePlays.ts
 */

import { createReadStream, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { RAW_DIR } from "../src/data/nflverse.js";
import { splitLine } from "../src/data/csv.js";

const SEASONS = [2022, 2023, 2024, 2025];
const OUT = join(RAW_DIR, "..", "curated", "plays.csv");

/**
 * A flag that wipes out the snap is a no_play in the release, and it
 * is written as its own kind of play with the penalty yards as the
 * yards. `penalty` is a defensive one that hands over a first down:
 * it happens on 16% of drives and keeps them alive, which nothing
 * else here can do. `offenceFlag` is a false start or a hold, on 4.5%
 * of snaps, that replays the down from further back; `defenceFlag` is
 * an offside that moves the ball without moving the chains.
 */
const FLAGS = ["penalty", "offenceFlag", "defenceFlag"];

const offenceGroup = (text: string): string => {
  const backs = Number(/(\d+) RB/.exec(text)?.[1] ?? NaN);
  const tightEnds = Number(/(\d+) TE/.exec(text)?.[1] ?? NaN);

  if (!Number.isFinite(backs) || !Number.isFinite(tightEnds)) return "";
  if (backs === 1 && tightEnds === 1) return "11";
  if (backs === 1 && tightEnds === 2) return "12";
  if (backs === 2 && tightEnds === 1) return "21";
  if (backs + tightEnds >= 3) return "heavy";
  return "spread";
};

const defenceShell = (text: string): string => {
  let backs = 0;

  for (const spot of ["CB", "FS", "SS", "S", "DB"]) {
    backs += Number(new RegExp(`(\\d+) ${spot}(?:,|$)`).exec(text)?.[1] ?? 0);
  }

  if (backs < 4) return "";
  if (backs === 4) return "base";
  if (backs === 5) return "nickel";
  return "dime";
};

async function personnelFor(season: number) {
  const path = join(RAW_DIR, `participation_${season}.csv`);
  const byPlay = new Map<string, { offence: string; defence: string; box: number }>();

  if (!existsSync(path)) {
    return byPlay;
  }

  const reader = createInterface({ input: createReadStream(path) });
  let header: string[] | undefined;
  let iGame = -1, iPlay = -1, iOff = -1, iDef = -1, iBox = -1;

  for await (const line of reader) {
    if (!header) {
      header = splitLine(line);
      iGame = header.indexOf("nflverse_game_id");
      iPlay = header.indexOf("play_id");
      iOff = header.indexOf("offense_personnel");
      iDef = header.indexOf("defense_personnel");
      iBox = header.indexOf("defenders_in_box");
      continue;
    }

    const c = splitLine(line);
    byPlay.set(`${c[iGame]}|${c[iPlay]}`, {
      offence: offenceGroup(c[iOff] ?? ""),
      defence: defenceShell(c[iDef] ?? ""),
      box: Number(c[iBox]) || 0,
    });
  }

  return byPlay;
}

async function main(): Promise<void> {
  const rows: string[] = [
    "season,week,offense,defense,drive,down,togo,yardline,margin,seconds," +
      "grouping,shell,box,playType,yards,firstDown,touchdown,turnover," +
      "shotgun,noHuddle",
  ];

  for (const season of SEASONS) {
    const pbp = join(RAW_DIR, `play_by_play_${season}.csv`);

    if (!existsSync(pbp)) {
      continue;
    }

    const personnel = await personnelFor(season);
    const reader = createInterface({ input: createReadStream(pbp) });
    let header: string[] | undefined;
    const at: Record<string, number> = {};
    let written = 0;

    for await (const line of reader) {
      if (!header) {
        header = splitLine(line);
        for (const field of [
          "game_id", "play_id", "week", "posteam", "defteam", "drive",
          "down", "ydstogo", "yardline_100", "score_differential",
          "game_seconds_remaining", "play_type", "yards_gained",
          "first_down", "touchdown", "interception", "fumble_lost",
          "first_down_penalty", "penalty_yards", "penalty", "penalty_team",
          // at one state these move the call by 26 points, and a
          // side's habit is its own season to season at .61
          "shotgun", "no_huddle",
        ]) {
          at[field] = header.indexOf(field);
        }
        continue;
      }

      const c = splitLine(line);
      const raw = c[at["play_type"]!] ?? "";
      const movedByPenalty = c[at["first_down_penalty"]!] === "1";
      const type = movedByPenalty ? "penalty"
        : raw === "no_play" && c[at["penalty"]!] === "1"
          ? (c[at["penalty_team"]!] === c[at["posteam"]!] ? "offenceFlag" : "defenceFlag")
          : raw;

      if (!FLAGS.includes(type) && !["run", "pass", "punt", "field_goal"].includes(type)) {
        continue;
      }

      const down = Number(c[at["down"]!]);
      const yardline = Number(c[at["yardline_100"]!]);
      const offense = c[at["posteam"]!] ?? "";

      if (!Number.isFinite(down) || !Number.isFinite(yardline) || !offense) {
        continue;
      }

      const found = personnel.get(`${c[at["game_id"]!]}|${c[at["play_id"]!]}`);
      const lost = c[at["interception"]!] === "1" || c[at["fumble_lost"]!] === "1";

      rows.push([
        season, c[at["week"]!], offense, c[at["defteam"]!], c[at["drive"]!],
        down, c[at["ydstogo"]!], yardline,
        c[at["score_differential"]!] || 0, c[at["game_seconds_remaining"]!] || 0,
        found?.offence ?? "", found?.defence ?? "", found?.box || "",
        type,
        FLAGS.includes(type)
          ? c[at["penalty_yards"]!] || 0
          : c[at["yards_gained"]!] || 0,
        c[at["first_down"]!] === "1" ? 1 : 0,
        c[at["touchdown"]!] === "1" ? 1 : 0,
        lost ? 1 : 0,
        c[at["shotgun"]!] === "1" ? 1 : 0,
        c[at["no_huddle"]!] === "1" ? 1 : 0,
      ].join(","));
      written++;
    }

    console.log(`${season}: ${written} plays`);
  }

  await writeFile(OUT, rows.join("\n") + "\n");
  console.log(`wrote ${rows.length - 1} rows`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
