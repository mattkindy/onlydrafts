/**
 * Asks whether the top-share skill players lose share of their side's
 * touches in the fourth quarter of a lopsided game, which is what the
 * engine would have to model if it wanted starters pulled and garbage
 * time to look right.
 *
 * For every game-side it works out each player's share of his side's
 * rushes and of its targets in the first three quarters, picks the
 * leading back and the leading receiver by those shares, and then
 * measures the same shares over fourth quarter plays, cut by the score
 * margin band the engine already uses.
 *
 * Run: npx tsx scripts/garbageTimeShareProbe.ts [--seasons 2024,2025]
 */

import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { RAW_DIR } from "../src/data/nflverse.js";
import { seasonsAsked } from "../src/data/seasons.js";
import { splitLine } from "../src/data/csv.js";
import { marginBand, MARGIN_BANDS } from "../app/lib/simTables.js";

const TOUCHES = join(RAW_DIR, "..", "curated", "touches.csv");

/** the fourth quarter, and a play of overtime reads as zero rather than this */
const QUARTER_SECONDS = 900;

/** where a side with a two score lead starts running the clock out */
const LAST_FIVE = 300;

/** below this a side's share is one or two carries and says nothing */
const MIN_EARLY_PLAYS = 12;
const MIN_BAND_PLAYS = 5;

/**
 * The engine's own margin bands, except that its widest band on each
 * end is cut in two. Three scores is where a staff starts resting
 * people, and the engine's band runs from nine points upward, so the
 * two have to be told apart before anything is fitted to them.
 */
const BAND_NAMES = [
  "trail 17+", "trail 9-16", "trail 4-8", "trail 1-3", "tied", "lead 1-3",
  "lead 4-8", "lead 9-16", "lead 17+",
];

const BANDS = BAND_NAMES.length;

function bandOf(margin: number): number {
  const engine = marginBand(margin);

  if (engine === 0) {
    return margin <= -17 ? 0 : 1;
  }

  if (engine === MARGIN_BANDS - 1) {
    return margin >= 17 ? BANDS - 1 : BANDS - 2;
  }

  return engine + 1;
}

type Call = "run" | "pass";
const CALLS: Call[] = ["run", "pass"];

/** a player's touches on one side of one game, early and by band */
interface Tally {
  early: number;
  late: number[];
}

/** one fourth quarter snap, kept so snaps can be walked in order */
interface LatePlay {
  call: Call;
  player: string;
  seconds: number;
  band: number;
}

interface Side {
  season: number;
  team: string;
  week: number;
  earlyTotal: Record<Call, number>;
  lateTotal: Record<Call, number[]>;
  players: Map<string, Record<Call, Tally>>;
  late: LatePlay[];
}

function emptyTally(): Tally {
  return { early: 0, late: Array.from({ length: BANDS }, () => 0) };
}

function emptySide(season: number, team: string, week: number): Side {
  return {
    season,
    team,
    week,
    late: [],
    earlyTotal: { run: 0, pass: 0 },
    lateTotal: {
      run: Array.from({ length: BANDS }, () => 0),
      pass: Array.from({ length: BANDS }, () => 0),
    },
    players: new Map(),
  };
}

async function positionsFor(seasons: number[]): Promise<Map<string, string>> {
  const byId = new Map<string, string>();

  for (const season of seasons) {
    const path = join(RAW_DIR, `roster_weekly_${season}.csv`);

    if (!existsSync(path)) {
      continue;
    }

    const reader = createInterface({ input: createReadStream(path) });
    let header: string[] | undefined;
    let idAt = -1;
    let positionAt = -1;

    for await (const line of reader) {
      if (!header) {
        header = splitLine(line);
        idAt = header.indexOf("gsis_id");
        positionAt = header.indexOf("position");
        continue;
      }

      const cells = splitLine(line);
      const id = cells[idAt] ?? "";
      const position = cells[positionAt] ?? "";

      if (id && position) {
        byId.set(id, position);
      }
    }
  }

  return byId;
}

/** every side of every game, keyed season-week-offence */
async function sidesFor(seasons: number[]): Promise<Map<string, Side>> {
  const sides = new Map<string, Side>();
  const wanted = new Set(seasons);
  const reader = createInterface({ input: createReadStream(TOUCHES) });
  let header: string[] | undefined;
  const at: Record<string, number> = {};

  for await (const line of reader) {
    if (!header) {
      header = splitLine(line);

      for (const field of [
        "season", "week", "offense", "margin", "seconds", "playType", "player",
      ]) {
        at[field] = header.indexOf(field);
      }

      continue;
    }

    const cells = splitLine(line);
    const season = Number(cells[at["season"]!]);

    if (!wanted.has(season)) {
      continue;
    }

    const call = cells[at["playType"]!] as Call;
    const player = cells[at["player"]!] ?? "";

    if (!CALLS.includes(call) || !player) {
      continue;
    }

    const seconds = Number(cells[at["seconds"]!]);
    const margin = Number(cells[at["margin"]!]);

    if (!Number.isFinite(seconds) || !Number.isFinite(margin) || seconds <= 0) {
      continue;
    }

    const team = cells[at["offense"]!] ?? "";
    const week = Number(cells[at["week"]!]);
    const key = `${season}|${week}|${team}`;
    let side = sides.get(key);

    if (!side) {
      side = emptySide(season, team, week);
      sides.set(key, side);
    }

    let tally = side.players.get(player);

    if (!tally) {
      tally = { run: emptyTally(), pass: emptyTally() };
      side.players.set(player, tally);
    }

    if (seconds > QUARTER_SECONDS) {
      side.earlyTotal[call]++;
      tally[call].early++;
      continue;
    }

    const band = bandOf(margin);
    side.lateTotal[call][band]!++;
    tally[call].late[band]!++;
    side.late.push({ call, player, seconds, band });
  }

  return sides;
}

/**
 * How many early touches each player had across his club's whole
 * season. Picking the leading man from this, with the game in question
 * taken back out, keeps the choice out of the game being measured, so
 * the man who happened to have a big first half is not counted as
 * losing share afterwards.
 */
function seasonEarly(sides: Map<string, Side>, call: Call) {
  const across = new Map<string, Map<string, number>>();

  for (const side of sides.values()) {
    const key = `${side.season}|${side.team}`;
    let byPlayer = across.get(key);

    if (!byPlayer) {
      byPlayer = new Map();
      across.set(key, byPlayer);
    }

    for (const [id, tally] of side.players) {
      byPlayer.set(id, (byPlayer.get(id) ?? 0) + tally[call].early);
    }
  }

  return across;
}

function leader(
  side: Side, call: Call, keep: (id: string) => boolean,
  across: Map<string, Map<string, number>>,
): string | undefined {
  const byPlayer = across.get(`${side.season}|${side.team}`);
  let best: string | undefined;
  let most = 0;

  for (const [id, total] of byPlayer ?? []) {
    const elsewhere = total - (side.players.get(id)?.[call].early ?? 0);

    if (elsewhere > most && keep(id)) {
      best = id;
      most = elsewhere;
    }
  }

  return best;
}

interface Pooled {
  earlyOwn: number;
  earlySide: number;
  lateOwn: number;
  lateSide: number;
  games: number;
}

function report(
  label: string, call: Call, sides: Map<string, Side>,
  keep: (id: string) => boolean,
) {
  const pooled: Pooled[] = Array.from(
    { length: BANDS },
    () => ({ earlyOwn: 0, earlySide: 0, lateOwn: 0, lateSide: 0, games: 0 }),
  );

  const across = seasonEarly(sides, call);

  for (const side of sides.values()) {
    if (side.earlyTotal[call] < MIN_EARLY_PLAYS) {
      continue;
    }

    const id = leader(side, call, keep, across);
    const tally = id ? side.players.get(id)?.[call] : undefined;

    if (!tally) {
      continue;
    }

    for (let band = 0; band < BANDS; band++) {
      const sideLate = side.lateTotal[call][band]!;

      if (sideLate < MIN_BAND_PLAYS) {
        continue;
      }

      const row = pooled[band]!;
      row.earlyOwn += tally.early;
      row.earlySide += side.earlyTotal[call];
      row.lateOwn += tally.late[band]!;
      row.lateSide += sideLate;
      row.games++;
    }
  }

  console.log(`\n${label} (${call} touches)`);
  console.log("margin at the snap   early   Q4     ratio  sides  Q4 plays");

  for (let band = 0; band < BANDS; band++) {
    const row = pooled[band]!;

    if (!row.games) {
      continue;
    }

    const early = row.earlyOwn / row.earlySide;
    const late = row.lateOwn / row.lateSide;
    console.log(
      `${BAND_NAMES[band]!.padEnd(20)} ${(early * 100).toFixed(1).padStart(5)}` +
      ` ${(late * 100).toFixed(1).padStart(5)} ${(late / early).toFixed(3)
        .padStart(8)} ${String(row.games).padStart(6)}` +
      ` ${String(row.lateSide).padStart(9)}`,
    );
  }
}

/** which game-sides were division games, keyed season-week-team */
async function divisionGames(seasons: number[]): Promise<Set<string>> {
  const found = new Set<string>();
  const reader = createInterface({
    input: createReadStream(join(RAW_DIR, "games.csv")),
  });
  let header: string[] | undefined;
  const at: Record<string, number> = {};

  for await (const line of reader) {
    if (!header) {
      header = splitLine(line);

      for (const field of [
        "season", "week", "home_team", "away_team", "div_game", "game_type",
      ]) {
        at[field] = header.indexOf(field);
      }

      continue;
    }

    const cells = splitLine(line);
    const season = Number(cells[at["season"]!]);

    if (!seasons.includes(season) || cells[at["game_type"]!] !== "REG"
      || cells[at["div_game"]!] !== "1") {
      continue;
    }

    const week = cells[at["week"]!];

    for (const side of ["home_team", "away_team"]) {
      found.add(`${season}|${week}|${cells[at[side]!]}`);
    }
  }

  return found;
}

/** the two widest bands, which is where anything happens */
const WIDE = { "trail 17+": 0, "lead 17+": BANDS - 1 };
const MIDDLING = { "trail 9-16": 1, "lead 9-16": BANDS - 2 };

/** what a side's snaps in one margin band say about one player */
interface Walked {
  earlyOwn: number;
  earlySide: number;
  /** his touches and the side's, by how many band snaps had gone before */
  ownAt: number[];
  sideAt: number[];
  /** the same split at the top and the bottom of the quarter */
  ownEarlyHalf: number;
  sideEarlyHalf: number;
  ownLateHalf: number;
  sideLateHalf: number;
  sides: number;
}

function emptyWalked(): Walked {
  return {
    earlyOwn: 0, earlySide: 0, ownAt: [], sideAt: [], ownEarlyHalf: 0,
    sideEarlyHalf: 0, ownLateHalf: 0, sideLateHalf: 0, sides: 0,
  };
}

/**
 * Walks each side's fourth quarter in order and counts, for every snap,
 * how many snaps of the same margin band had already gone by. A staff
 * that pulls a man and leaves him out shows up as his share falling off
 * with that count rather than being flat and low.
 */
function walk(
  side: Side, call: Call, band: number, id: string, into: Walked,
  within: (seconds: number) => boolean,
) {
  let gone = 0;
  let any = false;

  for (const play of side.late) {
    if (play.band !== band || !within(play.seconds)) {
      continue;
    }

    if (play.call === call) {
      any = true;
      into.sideAt[gone] = (into.sideAt[gone] ?? 0) + 1;
      into.ownAt[gone] = (into.ownAt[gone] ?? 0) + (play.player === id ? 1 : 0);

      if (play.seconds > QUARTER_SECONDS / 2) {
        into.sideEarlyHalf++;
        into.ownEarlyHalf += play.player === id ? 1 : 0;
      } else {
        into.sideLateHalf++;
        into.ownLateHalf += play.player === id ? 1 : 0;
      }
    }

    gone++;
  }

  if (any) {
    into.sides++;
    into.earlyOwn += side.players.get(id)![call].early;
    into.earlySide += side.earlyTotal[call];
  }
}

/**
 * The per-snap chance of being pulled that would leave the observed
 * average, given how far into the lopsided stretch the snaps came. It
 * assumes a man who comes out stays out, so the share after k snaps is
 * (1 - hazard) to the k.
 */
function hazardFor(w: Walked, ratio: number): number {
  const averageAt = (hazard: number) => {
    let weighted = 0;
    let total = 0;

    for (let k = 0; k < w.sideAt.length; k++) {
      const snaps = w.sideAt[k] ?? 0;
      weighted += snaps * (1 - hazard) ** k;
      total += snaps;
    }

    return total ? weighted / total : 1;
  };

  let low = 0;
  let high = 1;

  for (let i = 0; i < 80; i++) {
    const mid = (low + high) / 2;

    if (averageAt(mid) > ratio) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return (low + high) / 2;
}

const shareOf = (own: number, side: number) => (side ? own / side : 0);

function pullReport(
  label: string, call: Call, sides: Map<string, Side>,
  keep: (id: string) => boolean,
) {
  const across = seasonEarly(sides, call);
  const windows: Record<string, (seconds: number) => boolean> = {
    "whole Q4": () => true,
    "last 5 min": (seconds) => seconds <= LAST_FIVE,
  };
  console.log(`\n${label} (${call} touches), pulled or gradual`);
  console.log(
    "margin      window      ratio  first half  last half  hazard/snap" +
    "  sides  snaps");

  const cells = Array.from({ length: BANDS }, (_, band) =>
    Object.entries(windows).map(([window, within]) =>
      ({ band, window, within }))).flat();

  for (const { band, window, within } of cells) {
    const w = emptyWalked();

    for (const side of sides.values()) {
      if (side.earlyTotal[call] < MIN_EARLY_PLAYS
        || side.lateTotal[call][band]! < MIN_BAND_PLAYS) {
        continue;
      }

      const id = leader(side, call, keep, across);

      if (id && side.players.get(id)?.[call]) {
        walk(side, call, band, id, w, within);
      }
    }

    const name = `${BAND_NAMES[band]!} ${window}`;
    const early = shareOf(w.earlyOwn, w.earlySide);
    const snaps = w.sideAt.reduce((sum, n) => sum + (n ?? 0), 0);
    const late = shareOf(
      w.ownAt.reduce((sum, n) => sum + (n ?? 0), 0), snaps);
    const ratio = early ? late / early : 0;
    // the last five minutes are all in the second half of the quarter,
    // so splitting that window in two would print an empty column
    const halves = window === "whole Q4";
    const first = halves && early
      ? shareOf(w.ownEarlyHalf, w.sideEarlyHalf) / early : 0;
    const last = halves && early
      ? shareOf(w.ownLateHalf, w.sideLateHalf) / early : 0;

    if (!snaps) {
      continue;
    }

    console.log(
      `${name.padEnd(24)} ${ratio.toFixed(3)}` +
      `      ${halves ? first.toFixed(3) : "    -"}` +
      `      ${halves ? last.toFixed(3) : "    -"}` +
      `        ${hazardFor(w, ratio).toFixed(3)} ${String(w.sides).padStart(6)}` +
      ` ${String(snaps).padStart(6)}`,
    );

    if (window !== "whole Q4") {
      continue;
    }

    const buckets = [[0, 4], [5, 9], [10, 19], [20, 99]];
    const byBucket = buckets.map(([from, to]) => {
      let own = 0;
      let all = 0;

      for (let k = from!; k <= to!; k++) {
        own += w.ownAt[k] ?? 0;
        all += w.sideAt[k] ?? 0;
      }

      return `${from}-${to}: ${early && all
        ? (shareOf(own, all) / early).toFixed(2) : "-"} (${all})`;
    });

    console.log(`   by band snaps already gone   ${byBucket.join("  ")}`);
  }
}

function splitReport(
  label: string, call: Call, sides: Map<string, Side>,
  keep: (id: string) => boolean, division: Set<string>,
) {
  const across = seasonEarly(sides, call);
  const cuts: Record<string, (side: Side) => boolean> = {
    "division": (side) => division.has(`${side.season}|${side.week}|${side.team}`),
    "not division": (side) =>
      !division.has(`${side.season}|${side.week}|${side.team}`),
    "week 13+": (side) => side.week >= 13,
    "week 1-12": (side) => side.week < 13,
  };

  console.log(`\n${label} (${call} touches), by what was at stake`);
  console.log("margin       cut            ratio  sides  Q4 plays");

  for (const [name, band] of Object.entries({ ...WIDE, ...MIDDLING })) {
    for (const [cut, wanted] of Object.entries(cuts)) {
      let earlyOwn = 0;
      let earlySide = 0;
      let lateOwn = 0;
      let lateSide = 0;
      let games = 0;

      for (const side of sides.values()) {
        const sideLate = side.lateTotal[call][band]!;

        if (side.earlyTotal[call] < MIN_EARLY_PLAYS || sideLate < MIN_BAND_PLAYS
          || !wanted(side)) {
          continue;
        }

        const id = leader(side, call, keep, across);
        const tally = id ? side.players.get(id)?.[call] : undefined;

        if (!tally) {
          continue;
        }

        earlyOwn += tally.early;
        earlySide += side.earlyTotal[call];
        lateOwn += tally.late[band]!;
        lateSide += sideLate;
        games++;
      }

      const early = shareOf(earlyOwn, earlySide);
      const ratio = early ? shareOf(lateOwn, lateSide) / early : 0;
      console.log(
        `${name.padEnd(12)} ${cut.padEnd(14)} ${ratio.toFixed(3)}` +
        ` ${String(games).padStart(6)} ${String(lateSide).padStart(9)}`,
      );
    }
  }
}

async function main() {
  const seasons = seasonsAsked(process.argv, [2024, 2025]);
  const positions = await positionsFor(seasons);
  const sides = await sidesFor(seasons);

  console.log(`seasons ${seasons.join(", ")}, ${sides.size} game-sides`);
  console.log(
    "early is Q1 to Q3, Q4 is every snap with 900 seconds or fewer left,\n" +
    "shares are percent of the side's own plays on that call",
  );

  const isBack = (id: string) => ["RB", "FB"].includes(positions.get(id) ?? "");
  const isReceiver = (id: string) =>
    ["WR", "TE"].includes(positions.get(id) ?? "");

  report("top-share back", "run", sides, isBack);
  report("top-share receiver", "pass", sides, isReceiver);
  // a side chasing three scores runs less, and more of what it does run
  // is the quarterback, so his share says how much of the back's drop is
  // the pool changing under him rather than a backup coming in
  report("top-share quarterback", "run", sides,
    (id) => positions.get(id) === "QB");

  pullReport("top-share back", "run", sides, isBack);
  pullReport("top-share receiver", "pass", sides, isReceiver);
  pullReport("top-share quarterback", "run", sides,
    (id) => positions.get(id) === "QB");

  const division = await divisionGames(seasons);
  splitReport("top-share back", "run", sides, isBack, division);
  splitReport("top-share receiver", "pass", sides, isReceiver, division);
}

await main();
