/**
 * What a player adds to your chance of winning a week.
 *
 * Value over replacement asks how many points he beats a baseline by,
 * and the game is beating one other team on Sunday. The two come apart
 * wherever your own roster matters. Your first kicker is worth what he
 * beats the kicker off waivers by, and the second almost nothing. A
 * fifth back is worth nothing on paper and something in fact, because
 * byes and injuries mean he starts some weeks.
 *
 * So a week is drawn for everybody, the best legal lineup is filled,
 * and a player is worth the change in how often it beats a typical side.
 */

import { factorFor, mixFor, PASS_CATCHERS, type Mix } from "./copula.ts";
import { FLEX_POSITIONS, lineupOf, type Player } from "./scoring.ts";
import { DRAWS, streamFor, weeksFromNormals } from "./spread.ts";

const WHERE = ["QB", "RB", "WR", "TE", "K", "DEF"];

/**
 * Who is in a slot: what you expect of him and what he scored. A player off
 * waivers is marked, because you play your own player over a pickup when
 * the two of them are as good as each other.
 */
export interface Held {
  expect: number;
  score: number;
  wire?: boolean;
  /** his key, so a page can name the player a newcomer pushes out */
  who?: string;
}

export interface Baseline {
  /** what your lineup scores in each drawn week */
  total: number[];
  /**
   * The player a newcomer at each position would push out, week by week:
   * what you expect of him, which is what decides who you start, and
   * what he actually scored, which is what you give up by benching him.
   *
   * Both, because a lineup is set on Thursday. Starting whoever turns
   * out best is a start and sit nobody gets to make, and it paid a
   * second kicker two and a half points of win chance for the weeks he
   * happened to beat the first.
   */
  displaced: Record<string, Held[]>;
  /** how many drawn weeks each player was in the lineup, by his key */
  started: Record<string, number>;
  /**
   * How many of those weeks he spent in each slot, by his key and then
   * by the slot's name. A back who plays the flex half the time and the
   * second back the other half has two entries, so a page naming one
   * slot has to pick the commonest.
   */
  startedIn: Record<string, Record<string, number>>;
}

/** the slot he was in most of the weeks he started, if he started at all */
export function slotOf(
  filled: Pick<Baseline, "startedIn">, key: string,
): string | null {
  const his = filled.startedIn[key];

  if (!his) {
    return null;
  }

  let slot: string | null = null;

  for (const [where, weeks] of Object.entries(his)) {
    if (slot === null || weeks > his[slot]!) {
      slot = where;
    }
  }

  return slot;
}

/** The season is this many weeks, and every player has a bye in one of them. */
export const SEASON_WEEKS = 18;

/**
 * Which week of the season a drawn week is. Every player's draws share
 * the count, so two players with the same bye miss the same draws, and a
 * roster that stacks a bye week feels it instead of each player missing
 * a week of his own.
 */
export function weekOfDraw(i: number): number {
  return (i % SEASON_WEEKS) + 1;
}

/** the other side each team plays in a given week, when anybody knows */
export type OpponentOf = (team: string, week: number) => string | null;

let opponentOf: OpponentOf | null = null;
let topCatchers: Set<string> | null = null;

/**
 * Who each team's first pass catcher is, which decides the sign he takes
 * the split factor with. A draw cannot see a player's teammates, so the
 * board says once, here, and the weeks drawn before it spoke are thrown
 * away because they were drawn without it.
 *
 * The split factor only has two signs, so the first pass catcher comes
 * out uncorrelated with each of the others, and any two of the others
 * pick up about 0.42 between them where the measurement says zero.
 */
export function notePassCatchers(
  players: Player[], opponents: OpponentOf | null = null,
): void {
  const best = new Map<string, Player>();

  for (const p of players) {
    if (!p.team || !PASS_CATCHERS.includes(p.position)) {
      continue;
    }

    const had = best.get(p.team);

    if (!had || (p.ppg ?? 0) > (had.ppg ?? 0)) {
      best.set(p.team, p);
    }
  }

  topCatchers = new Set([...best.values()].map((p) => p.key));
  opponentOf = opponents;
  drawn = new WeakMap();
  mixes = new Map();
}

/**
 * What a player's week in one drawn week is loaded on. The fixture changes
 * from week to week, so the loadings are worked out per drawn week and
 * kept, since filling a lineup asks for them over and over.
 */
function mixAt(p: Player, i: number): Mix {
  const week = weekOfDraw(i);
  const at = `${p.key}|${week}`;
  let his = mixes.get(at);

  if (!his) {
    his = mixFor(
      p,
      p.team ? opponentOf?.(p.team, week) ?? null : null,
      week,
      topCatchers ? topCatchers.has(p.key) : null,
    );
    mixes.set(at, his);
  }

  return his;
}

let mixes = new Map<string, Mix>();

/** a player's loadings for one week, with the factor draws already found */
interface Loaded {
  terms: { load: number; its: number[] }[];
  own: number;
  ownIts: number[];
}

/**
 * The normal behind each of a player's draws.
 *
 * His loadings change with the fixture and nothing else, so there are
 * eighteen sets of them however many weeks are drawn. Looking them up
 * per draw, and looking up each factor's numbers by name inside that,
 * was most of what drawing a board cost.
 */
function normalsFor(p: Player, draws: number): number[] {
  const byWeek: Loaded[] = Array.from({ length: SEASON_WEEKS }, (_, w) => {
    const mix = mixAt(p, w);

    return {
      terms: mix.terms.map((term) => ({
        load: term.load, its: factorFor(term.factor, draws),
      })),
      own: mix.own,
      ownIts: factorFor(mix.ownSeed, draws),
    };
  });

  return Array.from({ length: draws }, (_, i) => {
    const his = byWeek[i % SEASON_WEEKS]!;
    let z = 0;

    for (const term of his.terms) {
      z += term.load * term.its[i]!;
    }

    return z + his.own * his.ownIts[i]!;
  });
}

/**
 * A player's weeks, zeroed where he does not play: his bye, and the games
 * he is expected to miss. How many games he is expected to play already
 * prices his injury history and his age, so a fragile player misses weeks
 * here rather than being marked down evenly.
 */
export function weeksOf(p: Player, draws = DRAWS): number[] {
  let his = drawn.get(p);

  if (!his) {
    his = new Map();
    drawn.set(p, his);
  }

  const had = his.get(draws);

  if (had) {
    return had;
  }

  const weeks = drawWeeks(p, draws);
  his.set(draws, weeks);

  return weeks;
}

/**
 * Kept per player, because scoring a board the exact way fills a roster
 * once for every candidate and drew every player's weeks again each time.
 * The arrays are shared, so nobody writes into one.
 */
let drawn = new WeakMap<Player, Map<number, number[]>>();

function drawWeeks(p: Player, draws: number): number[] {
  const g = p.game;
  const plays = (p.games ?? SEASON_WEEKS - 1) / (SEASON_WEEKS - 1);

  if (!g?.["ev"]) {
    return new Array(draws).fill(0) as number[];
  }

  const weeks = weeksFromNormals(
    {
      ev: g["ev"]!, q1: g["q1"] ?? g["ev"]!, mid: g["mid"] ?? g["ev"]!,
      q3: g["q3"] ?? g["ev"]!, low: g["low"] ?? g["ev"]!,
      high: g["high"] ?? g["ev"]!,
    },
    normalsFor(p, draws),
  );

  const out = streamFor(p.key + "|out", draws);

  return weeks.map((week, i) => {
    if (p.bye != null && weekOfDraw(i) === p.bye) {
      return 0;
    }

    return out[i]! < plays ? week : 0;
  });
}

interface Slot {
  where: string[];
  /** what to call it on a page, which for a flex is not a position */
  slot: string;
  taken: Held | null;
}

/** every starting slot this league has, the named ones then the flexes */
function slotsOf(slotNames: string[] | null | undefined): Slot[] {
  const { named, flex } = lineupOf(slotNames);
  const slots: Slot[] = [];

  for (const [where, count] of Object.entries(named)) {
    for (let i = 0; i < count; i++) {
      slots.push({ where: [where], slot: where, taken: null });
    }
  }

  for (let i = 0; i < flex; i++) {
    slots.push({ where: FLEX_POSITIONS, slot: "FLEX", taken: null });
  }

  return slots;
}

/** one player of a roster, in the order the lineup takes them */
interface InOrder {
  p: Player;
  its: number[];
  expect: number;
}

/**
 * Your lineup drawn week by week, kept as who sat in which slot.
 *
 * A baseline reads its totals and its displaced slots off this. The
 * waiver page reads something else off it: with the lineup in hand,
 * what dropping one player costs is the players below him shuffling up a
 * slot, which is a short pass over the lineup rather than the whole
 * season filled again.
 */
export interface SeasonLineup {
  slots: Slot[];
  /**
   * What each slot is worth off the wire in a week nobody on the roster
   * fills it. A slot your roster cannot fill is not worth nothing: you
   * start whoever the wire gives you there, and a newcomer has to beat
   * him.
   *
   * He scores his average every week, because he is not one player. He
   * is whoever you pick up on Wednesday, and a spread there would hand
   * the baseline weeks he happened to go big without anybody having
   * chosen him for it. A flex takes the best of the positions it takes.
   */
  offWire: number[];
  /** the roster best expected first, since that is how a lineup is set */
  order: InOrder[];
  /** the slots each position can go in, as a bit per slot */
  fits: Record<string, number>;
  /** which slot each player took, by draw and then by his place in the order */
  at: Int8Array;
  /** the first drawn week this covers, since a caller can ask for a run */
  from: number;
  total: number[];
  started: Record<string, number>;
  startedIn: Record<string, Record<string, number>>;
}

export function seasonLineupFor(
  roster: Player[], slotNames: string[] | null | undefined, draws = DRAWS,
  wire: Record<string, number> = {}, only: [number, number] = [0, draws],
): SeasonLineup {
  const slots = slotsOf(slotNames);
  const order = roster
    .map((p) => ({ p, its: weeksOf(p, draws), expect: p.ppg ?? 0 }))
    .sort((a, b) => b.expect - a.expect);
  const fits: Record<string, number> = {};

  for (const where of WHERE) {
    fits[where] = slots.reduce(
      (mask, slot, s) => slot.where.includes(where) ? mask | (1 << s) : mask, 0);
  }

  const offWire = slots.map((slot) => slot.where.reduce(
    (best, where) => Math.max(best, wire[where] ?? 0), 0));
  const players = order.length;
  const full = (1 << slots.length) - 1;
  const at = new Int8Array((only[1] - only[0]) * players).fill(-1);
  const total: number[] = [];
  const started: Record<string, number> = {};
  const startedIn: Record<string, Record<string, number>> = {};

  for (let i = only[0]; i < only[1]; i++) {
    const row = (i - only[0]) * players;
    let open = full;
    let sum = 0;

    for (let m = 0; m < players; m++) {
      const player = order[m]!;
      const score = player.its[i]!;

      // only among the players who are playing at all
      if (score <= 0) {
        continue;
      }

      const could = open & (fits[player.p.position] ?? 0);

      if (!could) {
        continue;
      }

      // the first slot he fits, which is the lowest bit still set
      const s = 31 - Math.clz32(could & -could);
      open &= ~(1 << s);
      at[row + m] = s;
      sum += score;
      started[player.p.key] = (started[player.p.key] ?? 0) + 1;
      const his = startedIn[player.p.key] ??= {};
      const slot = slots[s]!.slot;
      his[slot] = (his[slot] ?? 0) + 1;
    }

    for (let s = 0; s < slots.length; s++) {
      if (open & (1 << s)) {
        sum += offWire[s]!;
      }
    }

    total.push(sum);
  }

  return { slots, offWire, order, fits, at, from: only[0], total, started, startedIn };
}

/**
 * Your lineup one drawn week at a time, and what a newcomer at each
 * position would have to beat to get into it.
 *
 * The second half is what makes scoring a whole board affordable. Once
 * the worst player he could push out is known, what he adds that week is
 * one subtraction, and nobody has the lineup filled again for them.
 */
export function baselineFor(
  roster: Player[], slots: string[] | null | undefined, draws = DRAWS,
  wire: Record<string, number> = {}, only: [number, number] = [0, draws],
): Baseline {
  const lineup = seasonLineupFor(roster, slots, draws, wire, only);

  return {
    total: lineup.total,
    displaced: displacedIn(lineup),
    started: lineup.started,
    startedIn: lineup.startedIn,
  };
}

/** who is in each slot in one drawn week, by his place in the order */
function inLineup(lineup: SeasonLineup, i: number, into: Int8Array): void {
  const players = lineup.order.length;
  const row = i * players;
  into.fill(-1);

  for (let m = 0; m < players; m++) {
    const s = lineup.at[row + m]!;

    if (s >= 0) {
      into[s] = m;
    }
  }
}

/** what a newcomer at each position would have to beat, week by week */
function displacedIn(lineup: SeasonLineup): Record<string, Held[]> {
  const displaced: Record<string, Held[]> = {};

  for (const where of WHERE) {
    displaced[where] = [];
  }

  const slotCount = lineup.slots.length;
  const who = new Int8Array(slotCount);

  for (let i = 0; i < lineup.total.length; i++) {
    inLineup(lineup, i, who);

    for (const where of WHERE) {
      const mask = lineup.fits[where] ?? 0;
      let worst: Held | null = null;
      let open = mask === 0;

      for (let s = 0; s < slotCount && !open; s++) {
        if (!(mask & (1 << s))) {
          continue;
        }

        const held = heldIn(lineup, who[s]!, s, i);

        if (!held) {
          open = true;
        } else if (!worst || held.expect < worst.expect) {
          worst = held;
        }
      }

      displaced[where]!.push(
        open || !worst ? { expect: 0, score: 0 } : worst);
    }
  }

  return displaced;
}

/** whoever is in a slot that week: a player of yours, the wire, or nobody */
function heldIn(
  lineup: SeasonLineup, m: number, s: number, i: number,
): Held | null {
  if (m >= 0) {
    const player = lineup.order[m]!;

    return {
      expect: player.expect, score: player.its[i + lineup.from]!, who: player.p.key,
    };
  }

  const off = lineup.offWire[s]!;

  return off > 0 ? { expect: off, score: off, wire: true } : null;
}

/** what your lineup scores each week once one player is gone, and who steps up */
export interface Without {
  total: number[];
  /** how many more weeks each player is in the lineup, by his key */
  gained: Record<string, number>;
}

/**
 * The same season with one player off the roster, worked out from the
 * lineup rather than filled again.
 *
 * A player you never started costs you nothing. In a week he did start,
 * his leaving opens his slot, and the fill below him is the same one it
 * was except that the first player who fits that slot and was in a later
 * one moves up into it, which opens the one he came from. The shuffle
 * ends when a player who was not starting takes it, or the wire fills it.
 */
export function withoutFor(lineup: SeasonLineup, key: string): Without {
  const gone = lineup.order.findIndex((player) => player.p.key === key);
  const total = [...lineup.total];
  const gained: Record<string, number> = {};

  if (gone < 0) {
    return { total, gained };
  }

  const players = lineup.order.length;

  for (let i = 0; i < total.length; i++) {
    const row = i * players;
    let hole = lineup.at[row + gone]!;

    if (hole < 0) {
      continue;
    }

    let sum = total[i]! - lineup.order[gone]!.its[i + lineup.from]!;

    for (let m = gone + 1; m < players && hole >= 0; m++) {
      const player = lineup.order[m]!;

      if (!((lineup.fits[player.p.position] ?? 0) & (1 << hole))) {
        continue;
      }

      const his = lineup.at[row + m]!;

      if (his > hole) {
        hole = his;
        continue;
      }

      if (his >= 0) {
        continue;
      }

      const score = player.its[i + lineup.from]!;

      if (score <= 0) {
        continue;
      }

      sum += score;
      gained[player.p.key] = (gained[player.p.key] ?? 0) + 1;
      hole = -1;
    }

    if (hole >= 0) {
      sum += lineup.offWire[hole]!;
    }

    total[i] = sum;
  }

  return { total, gained };
}

/**
 * A baseline over several rosters at once, each getting an equal run
 * of the drawn weeks. A roster you have not finished drafting is many
 * rosters, one per drawn draft, and its weeks are the weeks of all of
 * them together.
 */
export function baselineAcross(
  rosters: Player[][], slots: string[] | null | undefined, draws = DRAWS,
  wire: Record<string, number> = {},
): Baseline {
  const total: number[] = [];
  const displaced: Record<string, Held[]> = {};
  const started: Record<string, number> = {};
  const startedIn: Record<string, Record<string, number>> = {};

  for (const where of WHERE) {
    displaced[where] = [];
  }

  rosters.forEach((roster, k) => {
    const from = Math.floor((k * draws) / rosters.length);
    const to = Math.floor(((k + 1) * draws) / rosters.length);
    const base = baselineFor(roster, slots, draws, wire, [from, to]);

    total.push(...base.total);

    for (const where of WHERE) {
      displaced[where]!.push(...base.displaced[where]!);
    }

    for (const [key, count] of Object.entries(base.started)) {
      started[key] = (started[key] ?? 0) + count;
    }

    for (const [key, his] of Object.entries(base.startedIn)) {
      const mine = startedIn[key] ??= {};

      for (const [slot, count] of Object.entries(his)) {
        mine[slot] = (mine[slot] ?? 0) + count;
      }
    }
  });

  return { total, displaced, started, startedIn };
}

/**
 * A typical opponent's week: the middle team at every starting slot.
 * With twelve teams the sixth best back is somebody's first back and
 * the eighteenth is somebody's second, so the middle of each run is
 * what an ordinary side puts out.
 */
export function typicalWeek(
  players: Player[], slots: string[] | null | undefined, teams: number,
  draws = DRAWS,
): number[] {
  const { named, flex } = lineupOf(slots);
  const byPosition: Record<string, Player[]> = {};

  for (const p of players) {
    (byPosition[p.position] ??= []).push(p);
  }

  for (const its of Object.values(byPosition)) {
    its.sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999));
  }

  const theirs: Player[] = [];

  for (const [where, count] of Object.entries(named)) {
    for (let i = 0; i < count; i++) {
      const player = byPosition[where]?.[Math.floor(teams / 2) + i * teams];

      if (player) {
        theirs.push(player);
      }
    }
  }

  const taken = new Set(theirs.map((p) => p.key));

  for (let i = 0; i < flex; i++) {
    const pool = FLEX_POSITIONS
      .flatMap((where) => byPosition[where] ?? [])
      .filter((p) => !taken.has(p.key))
      .sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999));
    const player = pool[Math.floor(teams / 2) + i * teams];

    if (player) {
      theirs.push(player);
      taken.add(player.key);
    }
  }

  const weeks = theirs.map((p) => weeksOf(p, draws));

  return Array.from({ length: draws }, (_, i) =>
    weeks.reduce((sum, its) => sum + (its[i] ?? 0), 0));
}

/** how many drawn drafts the slots you have not filled are filled from */
export const FILLS = 8;

/**
 * Where he goes in one drawn draft: a triangular draw between the
 * earliest and the latest pick he has gone at, peaking at his average.
 * The same draw serves every turn, so a player gone by your fourth pick
 * is still gone by your fifth.
 */
export function drawnPick(p: Player, fill: number): number {
  if (!p.adp) {
    return Infinity;
  }

  let picks = picked.get(p);

  if (!picks) {
    const adp = p.adp;
    const low = Math.min(p.adpLow ?? adp, adp);
    const high = Math.max(p.adpHigh ?? adp, adp);
    const peak = (adp - low) / Math.max(1e-9, high - low);
    picks = streamFor(p.key + "|pick", FILLS).map((u) =>
      u < peak
        ? low + Math.sqrt(u * (high - low) * (adp - low))
        : high - Math.sqrt((1 - u) * (high - low) * (high - adp)));
    picked.set(p, picks);
  }

  return picks[fill]!;
}

const picked = new WeakMap<Player, number[]>();

/**
 * Your roster as it will look when the draft ends, in one drawn draft:
 * what you have, plus the player you get at each slot you have not filled.
 *
 * Who is still there at each of your turns is drawn, not assumed. The
 * fill used to take any player whose average draft position was at or
 * after the turn, as if he were certain to be there, which made the
 * player it assumed for you worth nothing to take now and made a slot you
 * could easily fail to fill look filled. Here a player is there for you
 * when his drawn pick comes after your turn.
 *
 * Measuring against what you have today says nothing on the first pick,
 * because one player against a whole side loses every week whoever he is,
 * and every candidate reads zero. It also makes an empty slot look
 * enormous when a late round would fill it nearly as well.
 *
 * Filling the slots first fixes both. A defence you take now is then
 * worth what he beats a fourteenth round defence by, and a back is
 * worth what he beats the back you would have got in the eighth.
 */
export function projectedRoster(
  mine: Player[], slotNames: string[] | null | undefined, left: Player[],
  turns: number[], fill = 0,
): Player[] {
  const slots = slotsOf(slotNames);
  const filled = [...mine].sort((a, b) => (b.vor ?? 0) - (a.vor ?? 0));
  const spare = new Set(left.map((p) => p.key));
  const roster = [...mine];

  for (const p of mine) {
    spare.delete(p.key);
  }

  for (const p of filled) {
    const slot = slots.find((s) => !s.taken && s.where.includes(p.position));

    if (slot) {
      slot.taken = { expect: p.ppg ?? 0, score: 0 };
    }
  }

  /**
   * Turn by turn rather than slot by slot, taking the best player still
   * expected to be there who fits somewhere. Going down the slots in
   * order instead had you spending the third pick of the draft on a
   * quarterback, because the quarterback slot is listed first.
   */
  for (const at of turns) {
    const slot = slots.find((s) => !s.taken);

    if (!slot) {
      break;
    }

    const him = left.find((p) =>
      spare.has(p.key) &&
      drawnPick(p, fill) >= at &&
      slots.some((s) => !s.taken && s.where.includes(p.position)));

    if (!him) {
      continue;
    }

    const his = slots.find((s) => !s.taken && s.where.includes(him.position))!;
    his.taken = { expect: him.ppg ?? 0, score: 0 };
    roster.push(him);
    spare.delete(him.key);
  }

  return roster;
}

/** how often the first beats the second, week for week */
export function winChance(mine: number[], theirs: number[]): number {
  const weeks = Math.min(mine.length, theirs.length);
  let won = 0;

  for (let i = 0; i < weeks; i++) {
    if (mine[i]! > theirs[i]!) {
      won++;
    }
  }

  return won / Math.max(1, weeks);
}

export interface WinShare {
  /** how much more often you win a week with him than without */
  added: number;
  /** how often he ends up in the lineup at all */
  starts: number;
}

/**
 * A win share with the points behind it, for a page that has to say why
 * the number is what it is.
 *
 * A reader cannot tell a player who adds two points of win chance by
 * scoring eight more points a week from one who adds the same by
 * starting three weeks in twenty, and the two are different pickups.
 */
export interface Priced extends WinShare {
  /** how many more points a week your lineup scores with him */
  brings: number;
  /** how often you win a week as you are, and how often with him */
  before: number;
  after: number;
  /**
   * The player he pushes out of the lineup in most of the weeks he starts,
   * by his key. Nobody when the slot he takes was filled off the wire.
   */
  displaces: string | null;
}

/** whoever the count is highest for, or nobody when it is empty */
function commonest(counts: Map<string, number>): string | null {
  let best: string | null = null;

  for (const [key, n] of counts) {
    if (best === null || n > counts.get(best)!) {
      best = key;
    }
  }

  return best;
}

const meanOf = (xs: number[]) =>
  xs.reduce((sum, x) => sum + x, 0) / Math.max(1, xs.length);

/**
 * What taking each player at this turn does to your week, with the rest of
 * the draft filled in around him.
 *
 * He goes on the roster, the turns after this one are filled with the
 * best players expected to be there, and the lineup is drawn week by week.
 * That is set against the same roster with this turn passed over, so
 * the figure is what the pick itself is worth to you.
 *
 * The cheaper way, one baseline for the whole board, assumed the best
 * player left at every empty slot before asking what anybody added. He
 * then read zero, being measured against himself, and a second
 * quarterback read as much as a first with the assumed one still there.
 */
export function takeNowFor(
  mine: Player[], slots: string[] | null | undefined, left: Player[],
  turns: number[], opponent: number[], draws = DRAWS,
  wire: Record<string, number> = {},
): (p: Player) => WinShare {
  const later = turns.slice(1);
  const fills = Array.from({ length: FILLS }, (_, k) => k);
  const passed = baselineAcross(
    fills.map((k) => projectedRoster(mine, slots, left, later, k)),
    slots, draws, wire,
  );
  const without = winChance(passed.total, opponent);
  // the rest of the roster depends on where he plays and little else, so
  // a few rosters serve the whole board, each drawn once and him set into
  // it by displacement
  const around = new Map<
    string, { chance: number; share: (p: Player) => WinShare }
  >();

  return (p: Player) => {
    const rests = fills.map((k) =>
      projectedRoster([...mine, p], slots, left, later, k)
        .filter((q) => q.key !== p.key));
    const key = rests
      .map((rest) => rest.map((q) => q.key).sort().join("|"))
      .join("/");
    let his = around.get(key);

    if (!his) {
      const base = baselineAcross(rests, slots, draws, wire);
      his = {
        chance: winChance(base.total, opponent),
        share: winShareFor(base, opponent, draws),
      };
      around.set(key, his);
    }

    const with_ = his.share(p);

    return {
      added: his.chance + with_.added - without,
      starts: with_.starts,
    };
  };
}

/**
 * What each player on the board would add, all against one baseline.
 *
 * He goes in only where he beats the player he would push out, so a fifth
 * back gets the weeks the four above him miss and nothing else, and a
 * first kicker gets every week because the slot is empty.
 *
 * Quick, since the lineup is filled once for everybody, and right for
 * any player the baseline did not already assume. The board uses
 * takeNowFor, which has no such exception.
 */
/**
 * Whether you would start him over the player in the slot. A player of your
 * own goes in on a tie with somebody you would have to pick up, and
 * stays on the bench on a tie with somebody you already have.
 */
function wouldStart(his: number, slot: Held): boolean {
  if (slot.wire) {
    return his >= slot.expect;
  }

  return his > slot.expect;
}

/**
 * What a newcomer at each position has to expect to start in any drawn
 * week at all: the least the player he would push out expects, across the
 * whole season.
 *
 * A player off the wire goes in on a tie, so the bar is what he has to
 * reach rather than beat, and anybody under it is worth zero whatever
 * he goes on to score.
 */
export function barsOf(baseline: Baseline): Record<string, number> {
  const bars: Record<string, number> = {};

  for (const [where, beats] of Object.entries(baseline.displaced)) {
    let least = Infinity;

    for (const out of beats) {
      least = Math.min(least, out.expect);
    }

    bars[where] = beats.length ? least : 0;
  }

  return bars;
}

export function winShareFor(
  baseline: Baseline, opponent: number[], draws = DRAWS,
): (p: Player) => Priced {
  const without = winChance(baseline.total, opponent);
  const now = meanOf(baseline.total);
  const bars = barsOf(baseline);

  return (p: Player) => {
    const beats = baseline.displaced[p.position];
    const nothing = {
      added: 0, starts: 0, brings: 0, displaces: null,
      before: without, after: without,
    };

    if (!beats) {
      return nothing;
    }

    /**
     * Below the bar he never gets into the lineup in any drawn week, so
     * the loop below would come back with nothing and his weeks would
     * have been drawn for it. Most of the wire is below the bar.
     */
    if ((p.ppg ?? 0) < bars[p.position]!) {
      return nothing;
    }

    const his = weeksOf(p, draws);

    const withHim: number[] = [];
    const pushedOut = new Map<string, number>();
    let started = 0;

    for (let i = 0; i < baseline.total.length; i++) {
      const out = beats[i]!;
      // he starts on Thursday if you expect more of him, and he has to be
      // playing at all
      const plays = his[i]! > 0;
      const starts = plays && wouldStart(p.ppg ?? 0, out);

      if (starts) {
        started++;

        if (out.who) {
          pushedOut.set(out.who, (pushedOut.get(out.who) ?? 0) + 1);
        }
      }

      withHim.push(baseline.total[i]! + (starts ? his[i]! - out.score : 0));
    }

    const after = winChance(withHim, opponent);

    return {
      added: after - without,
      starts: started / Math.max(1, baseline.total.length),
      brings: meanOf(withHim) - now,
      before: without,
      after,
      displaces: commonest(pushedOut),
    };
  };
}
