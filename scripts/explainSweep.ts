/**
 * Where does a lower projection win the week more often? This builds a
 * plausible close matchup around every pass catcher who plays in an
 * opponent starter's game, offers a man projected for less in his seat,
 * and prints the swaps the model likes with the pieces behind them.
 *
 * Run: npx tsx scripts/explainSweep.ts [--week 1] [--show 8]
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { explainSwap } from "../app/lib/explain.ts";
import { liveDraws, sideTotals, spreadOf } from "../app/lib/matchups.ts";
import type { Side } from "../app/lib/providers.ts";
import { readSlate, type SlateRow } from "../app/lib/slate.ts";

const DATA = join(import.meta.dirname, "..", "docs", "data");

/** nobody has kicked off, so every man has his whole week to come */
const NOBODY = new Map();

const DRAWS = 6000;

/** what a shortlisted case is measured again on, where a piece settles down */
const CONFIRM = 120000;

const SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"];

const argOf = (flag: string, fallback: number) => {
  const at = process.argv.indexOf(flag);

  return at === -1 ? fallback : Number(process.argv[at + 1]);
};

const week = argOf("--week", 1);
const show = argOf("--show", 8);
const file = JSON.parse(
  readFileSync(join(DATA, `slate-2026-${week}.json`), "utf8"));
const slate = readSlate(file);
const rows = new Map(slate.rows.map((r) => [r.playerId, r]));
const by = (position: string) => slate.rows
  .filter((r) => r.position === position)
  .sort((a, b) => b.blend - a.blend);
const gameOf = (r: SlateRow) =>
  [r.team.toUpperCase(), r.opponent.toUpperCase()].sort().join("|");

/** the men in one of these games, so a filler can be kept out of them */
const inGames = (games: Set<string>) => (r: SlateRow) => games.has(gameOf(r));

const seat = (key: string, slot: string) => ({ key, slot, points: 0 });

const total = (keys: string[]) =>
  keys.reduce((sum, key) => sum + (rows.get(key)?.blend ?? 0), 0);

/**
 * A lineup filled out around the men already in it, taking the best man
 * left at each seat and keeping out of the two games under test, so
 * nobody else in the lineup moves with either of them.
 */
function fillOut(
  already: { key: string; slot: string }[],
  keep: Set<string>,
  games: Set<string>,
): { key: string; slot: string; points: number }[] {
  const taken = new Set([...already.map((m) => m.key), ...keep]);
  const busy = inGames(games);
  const out = already.map((m) => seat(m.key, m.slot));

  for (const slot of SLOTS) {
    const wanted = SLOTS.filter((s) => s === slot).length;

    if (out.filter((m) => m.slot === slot).length >= wanted) {
      continue;
    }

    const want = slot === "FLEX" ? ["RB", "WR", "TE"] : [slot];
    const found = want.flatMap((p) => by(p))
      .sort((a, b) => b.blend - a.blend)
      .find((r) => !taken.has(r.playerId) && !busy(r));

    if (found) {
      taken.add(found.playerId);
      out.push(seat(found.playerId, slot));
    }
  }

  return out;
}

/**
 * The opponent's lineup, built to land near my own total so the matchup
 * is close and a correlation is allowed to decide it. Each seat takes
 * whichever man left brings the two totals closest together.
 */
function opposite(
  already: { key: string; slot: string }[],
  want: number,
  keep: Set<string>,
  games: Set<string>,
): { key: string; slot: string; points: number }[] {
  const taken = new Set([...already.map((m) => m.key), ...keep]);
  const busy = inGames(games);
  const out = already.map((m) => seat(m.key, m.slot));
  const seats = SLOTS.slice();

  for (const one of already) {
    const at = seats.indexOf(one.slot);

    if (at >= 0) {
      seats.splice(at, 1);
    }
  }

  seats.forEach((slot, i) => {
    const positions = slot === "FLEX" ? ["RB", "WR", "TE"] : [slot];
    const left = seats.length - i - 1;
    const pool = positions.flatMap((p) => by(p))
      .filter((r) => !taken.has(r.playerId) && !busy(r));
    const aim = (want - total(out.map((m) => m.key))) / (left + 1);
    const found = pool.reduce((best: SlateRow | null, r) =>
      !best || Math.abs(r.blend - aim) < Math.abs(best.blend - aim) ? r : best,
      null);

    if (found) {
      taken.add(found.playerId);
      out.push(seat(found.playerId, slot));
    }
  });

  return out;
}

const pct = (n: number) => (n > 0 ? "+" : "") + (100 * n).toFixed(1) + "%";

interface Found {
  seated: SlateRow;
  instead: SlateRow;
  /** the opponent starter in the seated man's game, where there is one */
  theirs: string;
  mine: Side;
  against: Side;
  gains: number;
}

/**
 * How far ahead or behind the opponent is built to be. A tie in
 * correlation is worth nothing at even odds, because there the win
 * chance turns on the middle of your week and not on its width, so the
 * same pair of men is tried across a run of matchups.
 */
const OFFSETS = [-30, -18, -9, 0, 9, 18, 30];

/** the men worth a seat, in the seat each of them would take */
const WORTH_STARTING = [["WR", "WR"], ["TE", "TE"], ["RB", "RB"],
  ["QB", "QB"]] as const;

/** two men close enough in projection that the projection settles nothing */
const TIED = 0.8;

const pairsFor = (position: string) => {
  const men = by(position).filter((r) => r.blend >= 7).slice(0, 40);

  return men.flatMap((a) => men
    .filter((b) => b.blend < a.blend && a.blend - b.blend <= TIED)
    .map((b) => [a, b] as const));
};

/** one built matchup, measured however many draws the caller wants */
function measure(
  mine: Side, against: Side, seated: string, instead: string, draws: number,
) {
  const live = liveDraws(
    [...mine.starters, ...mine.bench, ...against.starters],
    rows, NOBODY, draws);

  return explainSwap({
    others: Array.from({ length: draws }, (_, i) =>
      mine.starters.reduce((sum, one) =>
        one.key === seated ? sum : sum + live.toCome(one.key)[i]!, 0)),
    starter: live.toCome(seated),
    candidate: live.toCome(instead),
    theirs: sideTotals(against, rows, NOBODY, draws, live),
  });
}

const found: Found[] = [];
let tried = 0;

for (const [position, slot] of WORTH_STARTING) {
  for (const [man, alone] of pairsFor(position)) {
    if (gameOf(alone) === gameOf(man)) {
      continue;
    }

    const games = new Set([gameOf(man), gameOf(alone)]);
    const starters = fillOut(
      [{ key: man.playerId, slot }], new Set([alone.playerId]), games);
    const mine: Side = {
      owner: "me",
      points: 0,
      starters,
      bench: [{ key: alone.playerId, points: 0 }],
    };
    const across = by("QB").find((q) =>
      gameOf(q) === gameOf(man) && q.playerId !== man.playerId &&
      q.playerId !== alone.playerId);

    for (const offset of OFFSETS) {
      const against: Side = {
        owner: "them",
        points: 0,
        starters: opposite(
          across ? [{ key: across.playerId, slot: "QB" }] : [],
          total(starters.map((m) => m.key)) + offset,
          new Set([man.playerId, alone.playerId]),
          new Set(across ? [gameOf(alone)] : [...games]),
        ),
        bench: [],
      };
      tried++;

      const why = measure(
        mine, against, man.playerId, alone.playerId, DRAWS);

      if (why.gains <= 0) {
        continue;
      }

      found.push({
        seated: man,
        instead: alone,
        theirs: across?.name ?? "nobody in his game",
        mine,
        against,
        gains: why.gains,
      });
    }
  }
}

found.sort((a, b) => b.gains - a.gains);

console.log(
  `week ${slate.week}: ${tried} matchups built, ${found.length} where the ` +
  `lower projection wins more often on ${DRAWS} draws.\n` +
  `The ones below are measured again on ${CONFIRM}, because a piece this ` +
  `size is about the same size as the noise in ${DRAWS}.\n`);

const width = (r: SlateRow) =>
  `${spreadOf(r).low.toFixed(1)} to ${spreadOf(r).high.toFixed(1)}`;
let said = 0;

for (const one of found) {
  if (said >= show) {
    break;
  }

  const why = measure(
    one.mine, one.against, one.seated.playerId, one.instead.playerId, CONFIRM);

  if (why.gains <= 0) {
    continue;
  }

  said++;

  console.log(
    `${one.instead.name} over ${one.seated.name} ` +
    `(${(one.instead.blend - one.seated.blend).toFixed(1)} projected points, ` +
    `${pct(why.gains)} win chance, you win ` +
    `${(100 * why.odds).toFixed(1)}%)`);
  console.log(
    `  ${one.seated.name} ${one.seated.blend.toFixed(1)} ` +
    `(${width(one.seated)}) plays ${one.seated.team} ${one.seated.opponent}, ` +
    `across from their ${one.theirs}`);
  console.log(
    `  ${one.instead.name} ${one.instead.blend.toFixed(1)} ` +
    `(${width(one.instead)}) plays ` +
    `${one.instead.team} ${one.instead.opponent}`);
  console.log(
    `  points ${pct(why.points)}   spread ${pct(why.spread)}   ` +
    `their game ${pct(why.opponent)}   your lineup ${pct(why.ownLineup)}   ` +
    `net ${pct(why.gains)}\n`);
}
