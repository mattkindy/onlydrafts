/**
 * Why one man beats another in a seat, in pieces a reader can follow.
 *
 * A swap is priced by drawing the week for both rosters and counting how
 * often your side ends up ahead, which gives a percentage and no account
 * of where it came from. This takes the same draws apart into four
 * pieces: his projected points, how wide his week is, how his week moves
 * with the opponent's lineup, and how it moves with the rest of yours.
 *
 * Each piece changes one thing about his draws and counts again, so the
 * four add up to the change exactly. Re-ordering a run of draws breaks a
 * tie between two men without touching either distribution, and both men
 * are re-ordered the same way so only the men differ.
 */

import { streamFor } from "./spread.ts";
import { winChance } from "./winShare.ts";

export interface Pieces {
  /** what the difference in projected points is worth */
  points: number;
  /** what the difference in floor and ceiling is worth on top of that */
  spread: number;
  /** what his week moving with the opponent's lineup is worth */
  opponent: number;
  /** and with the rest of your own lineup */
  ownLineup: number;
}

export interface Explanation extends Pieces {
  /** the whole change in win chance from starting the candidate */
  gains: number;
  /** how often you win the week as things stand */
  odds: number;
  /** what each man is projected for, off his own draws */
  projected: { starter: number; candidate: number };
  /** how wide each man's week is, as a standard deviation */
  width: { starter: number; candidate: number };
}

export interface Swapping {
  /** what the rest of your starters put up, draw by draw */
  others: number[];
  /** what the man in the seat puts up */
  starter: number[];
  /** and the man who would take it from him */
  candidate: number[];
  /** what the opponent's lineup puts up */
  theirs: number[];
}

const mean = (its: number[]) =>
  its.reduce((sum, n) => sum + n, 0) / Math.max(1, its.length);

function deviation(its: number[]): number {
  const middle = mean(its);
  const squares = its.reduce((sum, n) => sum + (n - middle) ** 2, 0);

  return Math.sqrt(squares / Math.max(1, its.length));
}

/**
 * The order a fixed stream puts the draws in. Fixed rather than random,
 * so a page opened twice explains a swap the same way both times.
 */
function orderOf(name: string, draws: number): number[] {
  const stream = streamFor(name, draws);

  return Array.from({ length: draws }, (_, i) => i)
    .sort((a, b) => stream[a]! - stream[b]!);
}

/**
 * The same draws in a different order: the values sorted, then dealt out
 * in the order the stream asks for. What comes back has the distribution
 * it went in with and no tie left to anybody else's draws.
 */
function reordered(its: number[], order: number[]): number[] {
  const sorted = [...its].sort((a, b) => a - b);
  const out = new Array(its.length).fill(0) as number[];

  order.forEach((at, rank) => { out[at] = sorted[rank]!; });

  return out;
}

const shiftedTo = (its: number[], middle: number) => {
  const by = middle - mean(its);

  return its.map((n) => n + by);
};

/**
 * How many times a piece is measured on a fresh re-ordering before the
 * four are averaged. One re-ordering is one sample of a world where the
 * tie is gone, and on a few thousand draws that sample is worth about a
 * point of win chance on its own, which is the size of the pieces. Six
 * of them cut that to something a reader can act on.
 */
const ROUNDS = 6;

/** what starting each of the two men does to your chance of winning */
export function explainSwap(swapping: Swapping): Explanation {
  const { others, starter, candidate, theirs } = swapping;
  const draws = Math.min(
    others.length, starter.length, candidate.length, theirs.length);
  const won = (his: number[], against: number[]) =>
    winChance(others.map((rest, i) => rest + his[i]!), against);
  const projected = { starter: mean(starter), candidate: mean(candidate) };
  const odds = won(starter, theirs);
  const gains = won(candidate, theirs) - odds;
  const pieces: Pieces = { points: 0, spread: 0, opponent: 0, ownLineup: 0 };

  for (let round = 0; round < ROUNDS; round++) {
    const loose = reordered(theirs, orderOf(`explain|against|${round}`, draws));
    const apart = orderOf(`explain|apart|${round}`, draws);
    const aloneStarter = reordered(starter, apart);
    const flat = won(aloneStarter, loose);
    const shifted = won(shiftedTo(aloneStarter, projected.candidate), loose);
    const swapped = won(reordered(candidate, apart), loose);
    const tied = won(candidate, loose) - won(starter, loose);

    pieces.points += (shifted - flat) / ROUNDS;
    pieces.spread += (swapped - shifted) / ROUNDS;
    pieces.ownLineup += (tied - (swapped - flat)) / ROUNDS;
    pieces.opponent += (gains - tied) / ROUNDS;
  }

  return {
    ...pieces,
    gains,
    odds,
    projected,
    width: { starter: deviation(starter), candidate: deviation(candidate) },
  };
}

/** how far apart two men are projected before it stops being a close call */
export const CLOSE = 1.5;

/** the smallest change in win chance worth putting a sentence next to */
const WORTH_SAYING = 0.005;

/**
 * Whether a swap changes how the seat reads. A man projected for more who
 * also wins more often says nothing a reader cannot already see, so the
 * ones explained are where the model disagrees with the projection and
 * where the two are close enough that the projection settles nothing.
 */
export function worthExplaining(gains: number, pointsGap: number): boolean {
  if (Math.abs(gains) < WORTH_SAYING) {
    return false;
  }

  return Math.abs(pointsGap) <= CLOSE || gains * pointsGap < 0;
}

type Cause = "opponent" | "spread" | "ownLineup";

const LEADS: Record<Cause, (good: boolean, underdog: boolean) => string> = {
  opponent: (good) => good
    ? "his week runs against the opponent's lineup, so his good afternoon is less likely to come with theirs."
    : "his week moves with the opponent's lineup, so his good afternoon tends to come with theirs.",
  spread: (good, underdog) => good
    ? (underdog
      ? "his is the wider week, and you need the top end of it to win from behind."
      : "his is the wider week, and the ceiling it adds is worth more here than the floor it costs.")
    : (underdog
      ? "his is the narrower week, which leaves you short of the big afternoon you need from behind."
      : "his is the narrower week, and you are ahead, so the steadier man keeps more of the lead."),
  ownLineup: (good, underdog) => good
    ? (underdog
      ? "his week moves with your other starters, which widens your whole week, and that helps from behind."
      : "his week runs against your other starters, which steadies your whole week, and you are ahead.")
    : (underdog
      ? "his week runs against your other starters, which steadies your whole week when you want the wild one."
      : "his week moves with your other starters, which widens your whole week, and you are the favourite."),
};

const biggestCause = (x: Explanation): [Cause, number] =>
  ([["opponent", x.opponent], ["spread", x.spread],
    ["ownLineup", x.ownLineup]] as [Cause, number][])
    .reduce((best, one) => Math.abs(one[1]) > Math.abs(best[1]) ? one : best);

/**
 * The one thing most worth saying about a swap, which is the biggest of
 * the three pieces that are not the points. Written to sit next to the
 * numbers, so it says what caused it and leaves the size to them.
 */
export function leadFor(x: Explanation): string {
  const [named, worth] = biggestCause(x);

  if (Math.abs(worth) < WORTH_SAYING) {
    return x.gains > 0
      ? "he wins more often because he is projected for more."
      : "the projection is the whole of it.";
  }

  return LEADS[named](worth > 0, x.odds < 0.5);
}
