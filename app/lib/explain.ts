/**
 * Why one player beats another in a lineup slot, in pieces a reader can
 * follow.
 *
 * Nothing here counts wins. In each draw the shared factors and every
 * other player's week stay at what that draw made them, and the only thing
 * left free is the noise of the player in the slot. His week is a ladder
 * in that noise, so the noise he needs to carry the lineup over the
 * opponent is written down rather than searched for, and a draw gives
 * a probability instead of a zero or a one.
 *
 * The four pieces each change one thing about him and ask again, each
 * measured against the step before it, so they add up to the whole
 * change exactly.
 */

import {
  normalLine, sharedAt, tiedTo, type From, type Mix, type Pace,
} from "./copula.ts";
import {
  normalCdf, normalQuantile, pointsOf, quantileOf, shiftedBy, weekAt,
  type Spread,
} from "./spread.ts";

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
  /** what each player is projected for, off his own draws */
  projected: { starter: number; candidate: number };
  /** how wide each player's week is, as a standard deviation */
  width: { starter: number; candidate: number };
}

/** one of the two players up for the slot, and how his week was drawn */
export interface Contender {
  /** what the draws give him on top of what he has already scored */
  week: number[];
  /** the five shipped figures those draws are read off */
  spread: Spread;
  mix: Mix;
  /** what he has put up already, which no draw moves */
  scored: number;
  /** the share of his week still to be drawn */
  left: number;
  pace: Pace;
}

/**
 * The open slot a player is priced in: everything about the week that is
 * not him.
 */
export interface Opening {
  /** what the rest of your starters put up, draw by draw */
  others: number[];
  /** what the opponent's lineup puts up */
  theirs: number[];
  /** what each factor came out at, draw by draw, as the players were drawn */
  factors: From;
  /** the factors the opponent's starters are loaded on */
  against: string[];
  /** and the factors the rest of your own starters are loaded on */
  alongside: string[];
}

/**
 * What he is projected for, off the shipped figures rather than off the
 * draws, so the gap the reader is shown is the gap between the two
 * projections on the page and not that gap plus a little drawing.
 */
const projectedFor = (his: Contender) =>
  his.scored + his.left * his.spread.ev;

function deviation(its: number[]): number {
  const middle = its.reduce((sum, n) => sum + n, 0) / Math.max(1, its.length);
  const squares = its.reduce((sum, n) => sum + (n - middle) ** 2, 0);

  return Math.sqrt(squares / Math.max(1, its.length));
}

/** what the opponent is ahead by before the player in the slot plays */
const gapsIn = (opening: Opening, draws: number) =>
  Array.from({ length: draws }, (_, i) => opening.theirs[i]! - opening.others[i]!);

/** below this his week is settled and there is nothing left to average */
const NO_ROOM = 1e-9;

/**
 * The chance he clears the gap in one draw, over his own noise and
 * nothing else. Everything the draw fixed stays fixed, so the answer is
 * where his ladder crosses the gap, read back through the normal that
 * picks his quantile.
 */
function chanceAt(
  his: Contender, spread: Spread, mix: Mix, gap: number,
  i: number, draws: number, factors: From,
): number {
  const needs = gap - his.scored;

  if (his.left <= 0) {
    return needs < 0 ? 1 : 0;
  }

  const { middle, width } = normalLine(
    mix, sharedAt(mix, i, draws, factors), his.pace);

  if (width <= NO_ROOM) {
    const week = weekAt(pointsOf(spread), normalCdf(middle));

    return his.left * week > needs ? 1 : 0;
  }

  const crossing = normalQuantile(quantileOf(spread, needs / his.left));

  return 1 - normalCdf((crossing - middle) / width);
}

function chanceOver(
  his: Contender, spread: Spread, mix: Mix, gaps: number[], factors: From,
): number {
  let sum = 0;

  for (let i = 0; i < gaps.length; i++) {
    sum += chanceAt(his, spread, mix, gaps[i]!, i, gaps.length, factors);
  }

  return sum / Math.max(1, gaps.length);
}

/** every factor the slot ties him to, on either side of the matchup */
const tyingIn = (opening: Opening) =>
  new Set([...opening.against, ...opening.alongside]);

/** how often you win the week with this player in the slot */
export function chanceWith(opening: Opening, his: Contender): number {
  const draws = Math.min(opening.others.length, opening.theirs.length);

  return chanceOver(
    his, his.spread, tiedTo(his.mix, tyingIn(opening)),
    gapsIn(opening, draws), opening.factors);
}

/**
 * His ladder moved so that what he adds is projected for so much more.
 * A player with part of his week behind him only draws the rest of it, so
 * the ladder has to move further than his total does.
 */
function movedTo(his: Contender, by: number): Spread {
  if (his.left <= 0) {
    return his.spread;
  }

  return shiftedBy(his.spread, by / his.left);
}

/** what starting each of the two players does to your chance of winning */
export function explainSwap(
  opening: Opening, starter: Contender, candidate: Contender,
): Explanation {
  const draws = Math.min(
    opening.others.length, opening.theirs.length,
    starter.week.length, candidate.week.length);
  const gaps = gapsIn(opening, draws);
  const tying = tyingIn(opening);
  const alongside = new Set(opening.alongside);
  const nobody = new Set<string>();
  const chance = (his: Contender, spread: Spread, keep: Set<string>) =>
    chanceOver(his, spread, tiedTo(his.mix, keep), gaps, opening.factors);
  const projected = {
    starter: projectedFor(starter),
    candidate: projectedFor(candidate),
  };
  const odds = chance(starter, starter.spread, tying);
  const gains = chance(candidate, candidate.spread, tying) - odds;
  // tied to nobody, so what is about him alone is not also a correlation
  const flat = chance(starter, starter.spread, nobody);
  const shifted = chance(
    starter, movedTo(starter, projected.candidate - projected.starter), nobody);
  const swapped = chance(candidate, candidate.spread, nobody);
  const tied = chance(candidate, candidate.spread, alongside) -
    chance(starter, starter.spread, alongside);

  return {
    points: shifted - flat,
    spread: swapped - shifted,
    ownLineup: tied - (swapped - flat),
    opponent: gains - tied,
    gains,
    odds,
    projected,
    width: {
      starter: deviation(starter.week),
      candidate: deviation(candidate.week),
    },
  };
}

/** how far apart two players are projected before it stops being a close call */
export const CLOSE = 1.5;

/** the smallest change in win chance worth putting a sentence next to */
const WORTH_SAYING = 0.005;

/**
 * Whether a swap changes how the slot reads. A player projected for more who
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
      : "his is the narrower week, and you are ahead, so the steadier player keeps more of the lead."),
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
