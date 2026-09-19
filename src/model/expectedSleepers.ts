/**
 * What a backup is worth over the rest of a season, in points rather than
 * in a chance times a price.
 *
 * A sleeper here is a player who would produce if he were given the
 * opportunity, weighted by the chance the opportunity arrives. The man in
 * front misses a week, which the season sim's absence model already
 * works out and nothing here refits. Or he keeps playing and loses the job
 * anyway, which is the benching fit below. What the backup would average
 * with the job is `wouldAverage` from the contingent score. The three
 * come together per remaining week and the weeks are summed.
 */

import { fitRidge, predictRidge } from "../backtest/ridge.js";
import { scalingFor, standardizedRow, type TermScaling } from "./termScaling.js";

/* ---------- the chance the man in front is benched ---------- */

/**
 * One backup behind one incumbent at one cut, with only the things a
 * reader could see that week.
 */
export interface BenchCut {
  position: string;
  /**
   * The incumbent's points a game so far less what a player bought at his
   * price averages. Negative is a starter playing below what the room
   * paid for him, which is the case a club benches.
   */
  starterGap: number;
  /** the backup went in the top hundred and is in his first two seasons */
  backupCapital: boolean;
  /** how far the backup's share of the snaps moved over the last three weeks */
  snapTrend: number;
}

interface Term {
  name: string;
  of: (cut: BenchCut) => number;
}

const at = (position: string) => (cut: BenchCut) =>
  cut.position === position ? 1 : 0;

const BENCH_TERMS: Term[] = [
  { name: "the starter against his price", of: (cut) => cut.starterGap },
  {
    name: "the backup's draft capital",
    of: (cut) => (cut.backupCapital ? 1 : 0),
  },
  { name: "his snaps over three weeks", of: (cut) => cut.snapTrend },
  { name: "is RB", of: at("RB") },
  { name: "is WR", of: at("WR") },
  { name: "is TE", of: at("TE") },
];

export const benchTermNames: readonly string[] =
  BENCH_TERMS.map((term) => term.name);

/** the raw value of every term, in `benchTermNames` order */
export const benchTermValues = (cut: BenchCut): number[] =>
  BENCH_TERMS.map((term) => term.of(cut));

/** one pair, and whether the backup had the job four weeks later */
export interface BenchExample {
  cut: BenchCut;
  season: number;
  /** the backup was starting four weeks on with the incumbent fit to play */
  benched: boolean;
}

export interface BenchFit extends TermScaling {
  trainedOn: number[];
  examples: number;
  /** how many of them the backup took the job off a fit incumbent */
  benched: number;
  /** the intercept, then one weight per term in `benchTermNames` order */
  weights: number[];
}

/** the same pull the other sleeper fits take, as a share of their rows */
export const LAMBDA_SHARE = 0.01;

/**
 * A club benching a fit starter is rare, so a ridge on a nought or one
 * gives back numbers either side of both ends and they are squeezed back
 * in. The floor is above zero because every club can bench anybody.
 */
const LOWEST = 0.002;
const HIGHEST = 0.5;

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

export function fitBenching(examples: BenchExample[]): BenchFit {
  if (examples.length <= BENCH_TERMS.length) {
    throw new Error(
      `a benching fit wants more than ${BENCH_TERMS.length} rows and has ` +
        `${examples.length}`,
    );
  }

  const scaling = scalingFor(examples.map((one) => benchTermValues(one.cut)));
  const X = examples.map((one) =>
    standardizedRow(scaling, benchTermValues(one.cut)));

  return {
    ...scaling,
    trainedOn: [...new Set(examples.map((one) => one.season))]
      .sort((a, b) => a - b),
    examples: examples.length,
    benched: examples.filter((one) => one.benched).length,
    weights: fitRidge(
      X, examples.map((one) => (one.benched ? 1 : 0)),
      Math.max(1e-6, LAMBDA_SHARE * examples.length),
    ),
  };
}

/** the fit a reader could have had before `season` kicked off */
export const fitBenchingAsOf = (
  season: number, examples: BenchExample[],
): BenchFit => fitBenching(examples.filter((one) => one.season < season));

/** the chance the backup has the job four weeks on, the incumbent fit */
export const benchChance = (fit: BenchFit, cut: BenchCut): number =>
  clamp(
    predictRidge(fit.weights, standardizedRow(fit, benchTermValues(cut))),
    LOWEST,
    HIGHEST,
  );

/** what each term weighs, with what it averaged over the rows behind it */
export const benchWeights = (
  fit: BenchFit,
): { term: string; weight: number; average: number }[] =>
  benchTermNames.map((term, i) => ({
    term,
    weight: fit.weights[i + 1] ?? 0,
    average: fit.means[i] ?? 0,
  }));

/* ---------- the chance the job is open in a given week ---------- */

/** the weeks a benching chance is measured over */
export const BENCH_HORIZON = 4;

export interface OpenInput {
  /** the chance the man in front misses any one week, from the absence model */
  missPerWeek: number;
  /** the chance the backup has the job four weeks on, from the fit above */
  benchedByFour: number;
  weeksLeft: number;
}

const weeklyBenching = (benchedByFour: number): number =>
  1 - (1 - clamp(benchedByFour, 0, 1)) ** (1 / BENCH_HORIZON);

/**
 * The chance the job is open in each remaining week, the first week after
 * the cut first.
 *
 * Missing a week is the same chance every week, because the absence model
 * draws a player down at a steady hazard and the weeks he is down are a
 * share of the season rather than something that builds up. Being benched
 * is the opposite, since a club that has moved on does not move back, so
 * the four week chance is spread into a weekly one and accumulated. A
 * week is open if either happened, which is one less the two complements
 * multiplied.
 */
export function openChances(input: OpenInput): number[] {
  const miss = clamp(input.missPerWeek, 0, 1);
  const weekly = weeklyBenching(input.benchedByFour);
  const out: number[] = [];

  for (let week = 1; week <= Math.max(0, input.weeksLeft); week++) {
    out.push(1 - (1 - miss) * (1 - weekly) ** week);
  }

  return out;
}

/** the chance the job opens at some point over the weeks that are left */
export function openChance(input: OpenInput): number {
  const miss = clamp(input.missPerWeek, 0, 1);
  const left = Math.max(0, input.weeksLeft);

  const weekly = weeklyBenching(input.benchedByFour);

  return 1 - (1 - miss) ** left * (1 - weekly) ** left;
}

/* ---------- the two sides together ---------- */

export interface ExpectedInput extends OpenInput {
  /** what he would average a game with the job */
  wouldAverage: number;
  /** what he averages in the role he has now */
  currentPpg: number;
}

export interface ExpectedScore {
  /** points added over the rest of the season for the roster spot he takes */
  expectedAdded: number;
  /** the same over the weeks his club has left */
  expectedPerGame: number;
  /** the chance the job opens at some point before the season ends */
  openChance: number;
}

/**
 * Every week he is worth the gap between what the job pays him and what
 * his present role pays him, and only in the weeks the job is open, so
 * the weeks are added up rather than averaged. A backup whose own role
 * already pays more than the job would comes out negative, which is the
 * right answer about him.
 */
export function expectedAdded(input: ExpectedInput): ExpectedScore {
  const gap = input.wouldAverage - input.currentPpg;
  const weeks = openChances(input);
  const added = weeks.reduce((sum, chance) => sum + chance * gap, 0);

  return {
    expectedAdded: added,
    expectedPerGame: weeks.length === 0 ? 0 : added / weeks.length,
    openChance: openChance(input),
  };
}
