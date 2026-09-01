/**
 * What a man is worth to your team rather than to a bare one.
 *
 * Value over replacement measures everyone against the last man the
 * league starts, which is right on the first pick and wrong on the
 * ninth: by then your back slots are full and the next back is a backup
 * for the two you have. So the number here is what he adds to your lineup
 * today less what the same slot buys at your next turn, both read off
 * the slots you have left and the men on the board.
 *
 * The second half needs draft position to know who lasts, so where too
 * few of the men who could fill a slot are priced this gives null and
 * the caller falls back to plain value.
 */

import { lineupOf, type Player } from "./scoring.ts";
import { expectedBestAt, type Draft } from "./picks.ts";

/** the positions a flex takes, which is what makes one back displace another */
const FLEX_POSITIONS = ["RB", "WR", "TE"];

/** below this many priced men at a slot, the second half is guesswork */
const ENOUGH_PRICED = 5;

export type Fills = "named" | "flex" | "bench";

export interface Openings {
  /** dedicated slots still open at each position */
  named: Record<string, number>;
  /** flex slots still open */
  flex: number;
  /** the men in a starting slot */
  starters: Player[];
  /** nothing in your lineup is open */
  full: boolean;
}

/**
 * Your lineup so far, every man into a slot of his own position
 * first and whoever is best left into the flexes. Filling flexes first
 * would seat a receiver in a flex and leave his own slot open, which
 * reads as a need you do not have.
 */
export function openingsAfter(
  slots: string[] | null | undefined, drafted: Player[],
): Openings {
  const { named, flex } = lineupOf(slots);
  const open: Record<string, number> = { ...named };
  const starters: Player[] = [];
  const spare: Player[] = [];
  const best = [...drafted].sort((a, b) => (b.vor ?? 0) - (a.vor ?? 0));

  for (const p of best) {
    if ((open[p.position] ?? 0) > 0) {
      open[p.position] = open[p.position]! - 1;
      starters.push(p);
      continue;
    }

    spare.push(p);
  }

  let flexOpen = flex;

  for (const p of spare) {
    if (flexOpen > 0 && FLEX_POSITIONS.includes(p.position)) {
      flexOpen--;
      starters.push(p);
    }
  }

  const full = flexOpen === 0 && Object.values(open).every((n) => n === 0);

  return { named: open, flex: flexOpen, starters, full };
}

/** which slot he would take if you drafted him now */
export function whereHeFits(position: string, open: Openings): Fills {
  if ((open.named[position] ?? 0) > 0) {
    return "named";
  }

  if (open.flex > 0 && FLEX_POSITIONS.includes(position)) {
    return "flex";
  }

  return "bench";
}

/** every position competing for the slot he would take */
function rivalsFor(position: string, fills: Fills): string[] {
  if (fills === "named") {
    return [position];
  }

  // a flex, or a seat he has to take off somebody, is contested by
  // everyone a flex can hold rather than by his own position alone
  return FLEX_POSITIONS.includes(position) ? FLEX_POSITIONS : [position];
}

/**
 * The man he has to beat to start, which is nobody when a slot is open.
 * When none is, taking him only helps by however much he beats the
 * worst starter he could displace.
 */
function incumbentValue(
  position: string, fills: Fills, open: Openings,
): number {
  if (fills !== "bench") {
    return 0;
  }

  const rivals = rivalsFor(position, fills);
  const beatable = open.starters
    .filter((p) => rivals.includes(p.position))
    .map((p) => p.vor ?? 0);

  return beatable.length ? Math.min(...beatable) : 0;
}

export interface NeedInput {
  men: Player[];
  draft: Draft;
  /** the overall pick of your turn after this one */
  nextTurn: number | null;
  open: Openings;
}

export interface NeedScore {
  /** what he adds over your lineup today, less what the slot buys later */
  score: number;
  fills: Fills;
  /** what you would get at the same slot at your next turn */
  later: number;
  /** the man he has to beat to start, when there is one */
  beats: number;
}

/**
 * Score every man by what he adds to your lineup. Built once for a
 * whole board, since the expensive half is per slot rather than per
 * player. Gives null where there is nothing to say: no next turn, or a
 * slot with too few priced men left to say what it buys later.
 */
export function needScorer(input: NeedInput): (p: Player) => NeedScore | null {
  const { men, draft, nextTurn, open } = input;

  if (!nextTurn) {
    return () => null;
  }

  const laterAt = new Map<string, number | null>();

  const laterFor = (position: string, fills: Fills) => {
    const rivals = rivalsFor(position, fills);
    const at = rivals.join("/");

    if (!laterAt.has(at)) {
      const eligible = men.filter((o) => rivals.includes(o.position));
      const priced = eligible.filter((o) =>
        o.adp && !draft.taken.has(o.key) && o.adp >= nextTurn - 24);

      laterAt.set(
        at,
        priced.length < ENOUGH_PRICED
          ? null
          : expectedBestAt(eligible, nextTurn, draft, null, null),
      );
    }

    return laterAt.get(at)!;
  };

  return (p: Player) => {
    const fills = whereHeFits(p.position, open);
    const later = laterFor(p.position, fills);

    if (later === null) {
      return null;
    }

    const beats = incumbentValue(p.position, fills, open);
    const nowWorth = Math.max(0, (p.vor ?? 0) - beats);
    const laterWorth = Math.max(0, later - beats);

    return {
      score: Number((nowWorth - laterWorth).toFixed(1)),
      fills,
      later: Number(later.toFixed(1)),
      beats: Number(beats.toFixed(1)),
    };
  };
}

/**
 * Whether to show him when you have asked for only what you still need.
 * Once every starting slot is filled this hides nothing, since the last
 * few rounds are the bench and that is the point of them.
 */
export function stillNeeded(position: string, open: Openings): boolean {
  if (open.full) {
    return true;
  }

  return whereHeFits(position, open) !== "bench";
}
