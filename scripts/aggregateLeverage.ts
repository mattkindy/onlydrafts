/**
 * Every player's weekly work counted twice, once as it was and once
 * weighted by how much the game was still in the balance, into
 * `data/curated/leverage.csv`.
 *
 * Raw usage cannot tell a back with eight first quarter carries in a tie
 * game from one with twelve down twenty one. The weight itself lives in
 * `src/model/leverage.ts`, which says why it is shaped the way it is.
 *
 * With no `--seasons` every season from 2015 to the one being played is
 * read again, which is several gigabytes of play files. A weekly refresh
 * asks for the season being played and the rest comes back as it was.
 * Run: npx tsx scripts/aggregateLeverage.ts [--seasons 2026]
 */

import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { currentSeason, RAW_DIR } from "../src/data/nflverse.js";
import { seasonsAsked } from "../src/data/seasons.js";
import { mergedTouches, type SeasonRows } from "../src/data/touchesSeasons.js";
import { splitLine } from "../src/data/csv.js";
import { LEVERAGE_SHAPE, leverageWeight } from "../src/model/leverage.js";
import {
  COUNTED, LEVERAGE_HEADER, leverageFile, zeroCounted, type Counted,
} from "../src/features/leverageUsage.js";

const FIRST_SEASON = 2015;
const SEASONS = Array.from(
  { length: Math.max(1, currentSeason() - FIRST_SEASON + 1) },
  (_, i) => FIRST_SEASON + i,
);
const OUT = leverageFile();

const RED_ZONE = 20;
const INSIDE_TEN = 10;

/** three decimals, and an integer written as one, so a rerun matches */
const trimmed = (value: number) => String(Math.round(value * 1000) / 1000);

/**
 * An empty cell and NA both read as absent. Without this an empty win
 * probability would come through Number as zero, which is a certain loss
 * rather than a gap.
 */
function numberIn(cell: string | undefined): number | undefined {
  if (cell === undefined || cell === "" || cell === "NA") {
    return undefined;
  }

  const value = Number(cell);

  return Number.isFinite(value) ? value : undefined;
}

interface Side {
  raw: Counted;
  weighted: Counted;
  players: Map<string, { raw: Counted; weighted: Counted }>;
}

const emptySide = (): Side =>
  ({ raw: zeroCounted(), weighted: zeroCounted(), players: new Map() });

/** what one play was worth to whoever took it, and to his side */
interface Took {
  player: string;
  weight: number;
  counts: Counted;
}

function tookOn(cells: string[], at: Record<string, number>): Took | undefined {
  const type = cells[at["play_type"]!] ?? "";

  if (type !== "run" && type !== "pass") {
    return undefined;
  }

  const named = type === "run"
    ? cells[at["rusher_player_id"]!] ?? ""
    : cells[at["receiver_player_id"]!] ?? "";

  // A sack or a throwaway has no receiver and is not a target, so it
  // counts for neither the player nor the total his share is divided by.
  if (!named.startsWith("00-")) {
    return undefined;
  }

  const down = numberIn(cells[at["down"]!]);
  const yardline = numberIn(cells[at["yardline_100"]!]);
  const counts = zeroCounted();
  const early = down === 1 || down === 2;

  if (type === "run") {
    counts.carries = 1;
    counts.earlyCarries = early ? 1 : 0;
  } else {
    counts.targets = 1;
    counts.earlyTargets = early ? 1 : 0;
    counts.receptions = cells[at["complete_pass"]!] === "1" ? 1 : 0;
    counts.airYards = numberIn(cells[at["air_yards"]!]) ?? 0;
  }

  if (yardline !== undefined && yardline <= RED_ZONE) {
    counts.redLooks = 1;
    counts.tenLooks = yardline <= INSIDE_TEN ? 1 : 0;
  }

  return {
    player: named,
    weight: leverageWeight({
      winProbability: numberIn(cells[at["wp"]!]),
      margin: numberIn(cells[at["score_differential"]!]) ?? 0,
      secondsLeft: numberIn(cells[at["game_seconds_remaining"]!]) ?? 0,
    }),
    counts,
  };
}

function bump(into: { raw: Counted; weighted: Counted }, took: Took): void {
  for (const field of COUNTED) {
    into.raw[field] += took.counts[field];
    into.weighted[field] += took.counts[field] * took.weight;
  }
}

/** every counted week of one season, empty when the play file is absent */
async function leverageIn(season: number): Promise<string[]> {
  const path = join(RAW_DIR, `play_by_play_${season}.csv`);

  if (!existsSync(path)) {
    return [];
  }

  const sides = new Map<string, Side>();
  const reader = createInterface({ input: createReadStream(path) });
  let header: string[] | undefined;
  const at: Record<string, number> = {};

  for await (const line of reader) {
    if (!header) {
      header = splitLine(line);

      for (const field of [
        "season_type", "week", "posteam", "down", "yardline_100",
        "score_differential", "game_seconds_remaining", "play_type", "wp",
        "air_yards", "complete_pass", "receiver_player_id", "rusher_player_id",
      ]) {
        at[field] = header.indexOf(field);
      }

      continue;
    }

    const cells = splitLine(line);
    const team = cells[at["posteam"]!] ?? "";

    if (cells[at["season_type"]!] !== "REG" || !team || team === "NA") {
      continue;
    }

    const took = tookOn(cells, at);

    if (!took) {
      continue;
    }

    const week = Number(cells[at["week"]!]);
    const key = `${week}|${team}`;
    const side = sides.get(key) ?? emptySide();
    bump(side, took);
    const his = side.players.get(took.player)
      ?? { raw: zeroCounted(), weighted: zeroCounted() };
    bump(his, took);
    side.players.set(took.player, his);
    sides.set(key, side);
  }

  return rowsFrom(season, sides);
}

function byWeekThenTeam(one: string, other: string): number {
  const [oneWeek, oneTeam] = one.split("|");
  const [otherWeek, otherTeam] = other.split("|");
  const weeks = Number(oneWeek) - Number(otherWeek);

  return weeks === 0 ? (oneTeam ?? "").localeCompare(otherTeam ?? "") : weeks;
}

/** sorted by week and then by player, so the file comes back identical */
function rowsFrom(season: number, sides: Map<string, Side>): string[] {
  const rows: string[] = [];

  for (const key of [...sides.keys()].sort(byWeekThenTeam)) {
    const side = sides.get(key)!;
    const [week, team] = key.split("|");

    for (const player of [...side.players.keys()].sort()) {
      const his = side.players.get(player)!;
      rows.push([
        season, week, team, player,
        ...COUNTED.map((field) => trimmed(his.raw[field])),
        ...COUNTED.map((field) => trimmed(his.weighted[field])),
        ...COUNTED.map((field) => trimmed(side.raw[field])),
        ...COUNTED.map((field) => trimmed(side.weighted[field])),
      ].join(","));
    }
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

  console.log(`weighting leverage by ${LEVERAGE_SHAPE}`);

  for (const season of asked) {
    const rows = await leverageIn(season);
    derived.set(season, rows);
    console.log(`${season}: ${rows.length} player weeks`);
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
  out.write(`${LEVERAGE_HEADER}\n`);

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
