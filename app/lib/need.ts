/**
 * Which of your starting seats are still open, and who can fill one.
 *
 * This is the roster arithmetic on its own. What a man is worth to you
 * once the seats are counted is a different question and a harder one,
 * answered by drawing weeks rather than by counting points.
 */

import { lineupOf, type Player } from "./scoring.ts";

/** the positions a flex takes, which is what makes one back displace another */
const FLEX_POSITIONS = ["RB", "WR", "TE"];

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
 * Your lineup so far, every man into a slot of his own position first
 * and whoever is best left into the flexes. Filling flexes first would
 * seat a receiver in a flex and leave his own slot open, which reads as
 * a need you do not have.
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
