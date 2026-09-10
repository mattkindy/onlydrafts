/**
 * What a man adds to your chance of winning a week.
 *
 * Value over replacement asks how many points he beats a baseline by,
 * and the game is beating one other team on Sunday. The two come apart
 * wherever your own roster matters. Your first kicker is worth what he
 * beats the kicker off waivers by, and the second almost nothing. A
 * fifth back is worth nothing on paper and something in fact, because
 * byes and injuries mean he starts some weeks.
 *
 * So a week is drawn for everybody, the best legal lineup is filled,
 * and a man is worth the change in how often it beats a typical side.
 */

import { lineupOf, type Player } from "./scoring.ts";
import { DRAWS, streamFor, weeksFromSpread } from "./spread.ts";

const FLEX_POSITIONS = ["RB", "WR", "TE"];

const WHERE = ["QB", "RB", "WR", "TE", "K", "DEF"];

/**
 * Who is in a seat: what you expect of him and what he scored. A man off
 * waivers is marked, because you play your own man over a pickup when
 * the two of them are as good as each other.
 */
export interface Held {
  expect: number;
  score: number;
  wire?: boolean;
}

export interface Baseline {
  /** what your lineup scores in each drawn week */
  total: number[];
  /**
   * The man a newcomer at each position would push out, week by week:
   * what you expect of him, which is what decides who you start, and
   * what he actually scored, which is what you give up by benching him.
   *
   * Both, because a lineup is set on Thursday. Seating whoever turns
   * out best is a start and sit nobody gets to make, and it paid a
   * second kicker two and a half points of win chance for the weeks he
   * happened to beat the first.
   */
  displaced: Record<string, Held[]>;
  /** how many drawn weeks each man was in the lineup, by his key */
  started: Record<string, number>;
}

/** The season is this many weeks, and every man has a bye in one of them. */
export const SEASON_WEEKS = 18;

/**
 * Which week of the season a drawn week is. Every man's draws share
 * the count, so two men with the same bye miss the same draws, and a
 * roster that stacks a bye week feels it instead of each man missing
 * a week of his own.
 */
export function weekOfDraw(i: number): number {
  return (i % SEASON_WEEKS) + 1;
}

/**
 * A man's weeks, zeroed where he does not play: his bye, and the games
 * he is expected to miss. How many games he is expected to play already
 * prices his injury history and his age, so a fragile man misses weeks
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
 * Kept per man, because scoring a board the exact way fills a roster
 * once for every candidate and drew every man's weeks again each time.
 * The arrays are shared, so nobody writes into one.
 */
const drawn = new WeakMap<Player, Map<number, number[]>>();

function drawWeeks(p: Player, draws: number): number[] {
  const g = p.game;
  const plays = (p.games ?? SEASON_WEEKS - 1) / (SEASON_WEEKS - 1);

  if (!g?.["ev"]) {
    return new Array(draws).fill(0) as number[];
  }

  const weeks = weeksFromSpread(
    {
      ev: g["ev"]!, q1: g["q1"] ?? g["ev"]!, mid: g["mid"] ?? g["ev"]!,
      q3: g["q3"] ?? g["ev"]!, low: g["low"] ?? g["ev"]!,
      high: g["high"] ?? g["ev"]!,
    },
    p.key,
    draws,
  );

  const out = streamFor(p.key + "|out", draws);

  return weeks.map((week, i) => {
    if (p.bye != null && weekOfDraw(i) === p.bye) {
      return 0;
    }

    return out[i]! < plays ? week : 0;
  });
}

interface Seat {
  where: string[];
  taken: Held | null;
}

/** every starting seat this league has, the named ones then the flexes */
function seatsOf(slots: string[] | null | undefined): Seat[] {
  const { named, flex } = lineupOf(slots);
  const seats: Seat[] = [];

  for (const [where, count] of Object.entries(named)) {
    for (let i = 0; i < count; i++) {
      seats.push({ where: [where], taken: null });
    }
  }

  for (let i = 0; i < flex; i++) {
    seats.push({ where: FLEX_POSITIONS, taken: null });
  }

  return seats;
}

/**
 * A seat your roster cannot fill this week is not worth nothing. You
 * start whoever the wire gives you there, so that man goes in it and a
 * newcomer has to beat him.
 *
 * He scores his average every week, because he is not one player. He is
 * whoever you pick up on Wednesday, and a spread there would hand the
 * baseline weeks he happened to go big without anybody having chosen
 * him for it. A flex takes the best of the positions it accepts.
 */
function fillFromTheWire(seated: Seat[], wire: Record<string, number>): void {
  for (const seat of seated) {
    if (seat.taken) {
      continue;
    }

    const off = seat.where.reduce(
      (best, where) => Math.max(best, wire[where] ?? 0), 0);

    if (off > 0) {
      seat.taken = { expect: off, score: off, wire: true };
    }
  }
}

/**
 * Your lineup one drawn week at a time, and what a newcomer at each
 * position would have to beat to get into it.
 *
 * The second half is what makes scoring a whole board affordable. Once
 * the worst man he could push out is known, what he adds that week is
 * one subtraction, and nobody has the lineup filled again for them.
 */
export function baselineFor(
  roster: Player[], slots: string[] | null | undefined, draws = DRAWS,
  wire: Record<string, number> = {}, only: [number, number] = [0, draws],
): Baseline {
  const seats = seatsOf(slots);
  // by what you expect of him, since that is what a lineup is set on
  const weeks = roster
    .map((p) => ({ p, its: weeksOf(p, draws), expect: p.ppg ?? 0 }))
    .sort((a, b) => b.expect - a.expect);
  const total: number[] = [];
  const displaced: Record<string, Held[]> = {};
  const started: Record<string, number> = {};

  for (const where of WHERE) {
    displaced[where] = [];
  }

  for (let i = only[0]; i < only[1]; i++) {
    const seated = seats.map((seat) => ({ ...seat }));

    for (const man of weeks) {
      const score = man.its[i]!;

      // only among the men who are playing at all
      if (score <= 0) {
        continue;
      }

      const seat = seated.find((s) =>
        !s.taken && s.where.includes(man.p.position));

      if (seat) {
        seat.taken = { expect: man.expect, score };
        started[man.p.key] = (started[man.p.key] ?? 0) + 1;
      }
    }

    fillFromTheWire(seated, wire);
    total.push(seated.reduce((sum, s) => sum + (s.taken?.score ?? 0), 0));

    for (const where of WHERE) {
      const his = seated.filter((s) => s.where.includes(where));
      const open = his.length === 0 || his.some((s) => !s.taken);
      const worst = open
        ? null
        : his.reduce((low, s) =>
          s.taken!.expect < low.taken!.expect ? s : low);

      displaced[where]!.push(
        worst ? { ...worst.taken! } : { expect: 0, score: 0 },
      );
    }
  }

  return { total, displaced, started };
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
  });

  return { total, displaced, started };
}

/**
 * A typical opponent's week: the middle team at every starting seat.
 * With twelve teams the sixth best back is somebody's first back and
 * the eighteenth is somebody's second, so the middle of each run is
 * what an ordinary side puts out.
 */
export function typicalWeek(
  men: Player[], slots: string[] | null | undefined, teams: number,
  draws = DRAWS,
): number[] {
  const { named, flex } = lineupOf(slots);
  const byPosition: Record<string, Player[]> = {};

  for (const p of men) {
    (byPosition[p.position] ??= []).push(p);
  }

  for (const its of Object.values(byPosition)) {
    its.sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999));
  }

  const theirs: Player[] = [];

  for (const [where, count] of Object.entries(named)) {
    for (let i = 0; i < count; i++) {
      const man = byPosition[where]?.[Math.floor(teams / 2) + i * teams];

      if (man) {
        theirs.push(man);
      }
    }
  }

  const taken = new Set(theirs.map((p) => p.key));

  for (let i = 0; i < flex; i++) {
    const pool = FLEX_POSITIONS
      .flatMap((where) => byPosition[where] ?? [])
      .filter((p) => !taken.has(p.key))
      .sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999));
    const man = pool[Math.floor(teams / 2) + i * teams];

    if (man) {
      theirs.push(man);
      taken.add(man.key);
    }
  }

  const weeks = theirs.map((p) => weeksOf(p, draws));

  return Array.from({ length: draws }, (_, i) =>
    weeks.reduce((sum, its) => sum + (its[i] ?? 0), 0));
}

/** how many drawn drafts the seats you have not filled are filled from */
export const FILLS = 8;

/**
 * Where he goes in one drawn draft: a triangular draw between the
 * earliest and the latest pick he has gone at, peaking at his average.
 * The same draw serves every turn, so a man gone by your fourth pick
 * is still gone by your fifth.
 */
function drawnPick(p: Player, fill: number): number {
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
 * what you have, plus the man you get at each seat you have not filled.
 *
 * Who is still there at each of your turns is drawn, not assumed. The
 * fill used to take any man whose average draft position was at or
 * after the turn, as if he were certain to be there, which made the
 * man it assumed for you worth nothing to take now and made a seat you
 * could easily fail to fill look filled. Here a man is there for you
 * when his drawn pick comes after your turn.
 *
 * Measuring against what you have today says nothing on the first pick,
 * because one man against a whole side loses every week whoever he is,
 * and every candidate reads nought. It also makes an empty seat look
 * enormous when a late round would fill it nearly as well.
 *
 * Filling the seats first fixes both. A defence you take now is then
 * worth what he beats a fourteenth round defence by, and a back is
 * worth what he beats the back you would have got in the eighth.
 */
export function projectedRoster(
  mine: Player[], slots: string[] | null | undefined, left: Player[],
  turns: number[], fill = 0,
): Player[] {
  const seats = seatsOf(slots);
  const filled = [...mine].sort((a, b) => (b.vor ?? 0) - (a.vor ?? 0));
  const spare = new Set(left.map((p) => p.key));
  const roster = [...mine];

  for (const p of mine) {
    spare.delete(p.key);
  }

  for (const p of filled) {
    const seat = seats.find((s) => !s.taken && s.where.includes(p.position));

    if (seat) {
      seat.taken = { expect: p.ppg ?? 0, score: 0 };
    }
  }

  /**
   * Turn by turn rather than seat by seat, taking the best man still
   * expected to be there who fits somewhere. Going down the seats in
   * order instead had you spending the third pick of the draft on a
   * quarterback, because the quarterback seat is listed first.
   */
  for (const at of turns) {
    const seat = seats.find((s) => !s.taken);

    if (!seat) {
      break;
    }

    const him = left.find((p) =>
      spare.has(p.key) &&
      drawnPick(p, fill) >= at &&
      seats.some((s) => !s.taken && s.where.includes(p.position)));

    if (!him) {
      continue;
    }

    const his = seats.find((s) => !s.taken && s.where.includes(him.position))!;
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
 * What taking each man at this turn does to your week, with the rest of
 * the draft filled in around him.
 *
 * He goes on the roster, the turns after this one are filled with the
 * best men expected to be there, and the lineup is drawn week by week.
 * That is set against the same roster with this turn passed over, so
 * the figure is what the pick itself is worth to you.
 *
 * The cheaper way, one baseline for the whole board, assumed the best
 * man left at every empty seat before asking what anybody added. He
 * then read nought, being measured against himself, and a second
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
  /**
   * The rest of the roster depends on where he plays and little else,
   * so a few rosters serve the whole board. Each is drawn once and he
   * is set into it by displacement, which comes to the same lineup as
   * drawing the roster again with him on it and costs one subtraction
   * a week.
   */
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
 * What each man on the board would add, all against one baseline.
 *
 * He goes in only where he beats the man he would push out, so a fifth
 * back gets the weeks the four above him miss and nothing else, and a
 * first kicker gets every week because the seat is empty.
 *
 * Quick, since the lineup is filled once for everybody, and right for
 * any man the baseline did not already assume. The board uses
 * takeNowFor, which has no such exception.
 */
/**
 * Whether you would start him over the man in the seat. A man of your
 * own goes in on a tie with somebody you would have to pick up, and
 * stays on the bench on a tie with somebody you already have.
 */
function wouldStart(his: number, seat: Held): boolean {
  if (seat.wire) {
    return his >= seat.expect;
  }

  return his > seat.expect;
}

export function winShareFor(
  baseline: Baseline, opponent: number[], draws = DRAWS,
): (p: Player) => WinShare {
  const without = winChance(baseline.total, opponent);

  return (p: Player) => {
    const his = weeksOf(p, draws);
    const beats = baseline.displaced[p.position];

    if (!beats) {
      return { added: 0, starts: 0 };
    }

    const withHim: number[] = [];
    let started = 0;

    for (let i = 0; i < baseline.total.length; i++) {
      const out = beats[i]!;
      /**
       * He starts on Thursday if you expect more of him, and he has to
       * be playing at all. What that costs or buys you is whatever the
       * two of them then went and scored.
       */
      const plays = his[i]! > 0;
      const starts = plays && wouldStart(p.ppg ?? 0, out);

      if (starts) {
        started++;
      }

      withHim.push(baseline.total[i]! + (starts ? his[i]! - out.score : 0));
    }

    return {
      added: winChance(withHim, opponent) - without,
      starts: started / Math.max(1, baseline.total.length),
    };
  };
}
