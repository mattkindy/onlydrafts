/**
 * What a man adds to your chance of winning a week.
 *
 * Value over replacement asks how many points he beats a baseline by,
 * and the game is beating one other team on Sunday. The two come apart
 * wherever your own roster matters. An empty kicker slot scores
 * nothing, so your first kicker is worth his whole output and the
 * second almost none of it. A fifth back is worth nothing on paper and
 * something in fact, because byes and injuries mean he starts some
 * weeks.
 *
 * So a week is drawn for everybody, the best legal lineup is filled,
 * and a man is worth the change in how often it beats a typical side.
 */

import { lineupOf, type Player } from "./scoring.ts";
import { DRAWS, streamFor, weeksFromSpread } from "./spread.ts";

const FLEX_POSITIONS = ["RB", "WR", "TE"];

const WHERE = ["QB", "RB", "WR", "TE", "K", "DEF"];

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
  displaced: Record<string, { expect: number; score: number }[]>;
}

/**
 * A man's weeks, zeroed where he does not play. How many games he is
 * expected to play already prices his injury history and his age, so a
 * fragile man misses weeks here rather than being marked down evenly.
 */
export function weeksOf(p: Player, draws = DRAWS): number[] {
  const g = p.game;
  const plays = (p.games ?? 17) / 17;

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

  return weeks.map((week, i) => (out[i]! < plays ? week : 0));
}

interface Seat {
  where: string[];
  taken: { expect: number; score: number } | null;
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
 * Your lineup one drawn week at a time, and what a newcomer at each
 * position would have to beat to get into it.
 *
 * The second half is what makes scoring a whole board affordable. Once
 * the worst man he could push out is known, what he adds that week is
 * one subtraction, and nobody has the lineup filled again for them.
 */
export function baselineFor(
  roster: Player[], slots: string[] | null | undefined, draws = DRAWS,
): Baseline {
  const seats = seatsOf(slots);
  const weeks = roster.map((p) => ({ p, its: weeksOf(p, draws) }));
  const total: number[] = [];
  const displaced: Record<string, { expect: number; score: number }[]> = {};

  for (const where of WHERE) {
    displaced[where] = [];
  }

  for (let i = 0; i < draws; i++) {
    const seated = seats.map((seat) => ({ ...seat }));
    // by what you expect of him, since that is what a lineup is set on,
    // and only among the men who are playing at all
    const men = weeks
      .map(({ p, its }) => ({ p, score: its[i]!, expect: p.ppg ?? 0 }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.expect - a.expect);

    for (const man of men) {
      const seat = seated.find((s) =>
        !s.taken && s.where.includes(man.p.position));

      if (seat) {
        seat.taken = { expect: man.expect, score: man.score };
      }
    }

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

  return { total, displaced };
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

/**
 * Your roster as it will look when the draft ends: what you have, plus
 * the man you would expect to get at each seat you have not filled.
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
  turns: number[],
): Player[] {
  const seats = seatsOf(slots);
  const filled = [...mine].sort((a, b) => (b.vor ?? 0) - (a.vor ?? 0));
  const spare = new Set(left.map((p) => p.key));
  const roster = [...mine];

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
      (!p.adp || p.adp >= at) &&
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
 * What each man on the board would add, all against one baseline.
 *
 * He goes in only where he beats the man he would push out, so a fifth
 * back gets the weeks the four above him miss and nothing else, and a
 * first kicker gets every week because the seat is empty.
 */
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
      const starts = plays && (p.ppg ?? 0) > out.expect;

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
