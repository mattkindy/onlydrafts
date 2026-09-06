/**
 * Mixing Sleeper's weekly projection with our own.
 *
 * The blend is a straight average of the two point totals at some weight,
 * where 0 is all ours and 1 is all Sleeper. The weight is chosen on one
 * season and reported on another, so it has to be fit from data rather
 * than picked, and the thing it is fit on is the same pair accuracy the
 * eval reports: for each slate, every pair of men, how often the higher
 * projection outscored the other.
 */

import { addPairs, emptyTally, pairRate } from "../backtest/pairs.js";

export interface BlendEntry {
  ours: number;
  sleeper: number;
  actual: number;
}

export const BLEND_WEIGHTS: readonly number[] = Array.from(
  { length: 21 },
  (_, i) => i / 20,
);

export function blendPoints(
  ours: number,
  sleeper: number,
  weight: number,
): number {
  return (1 - weight) * ours + weight * sleeper;
}

function pairRateAt(slates: BlendEntry[][], weight: number): number {
  const tally = emptyTally();

  for (const slate of slates) {
    addPairs(
      tally,
      slate.map((e) => ({
        predicted: blendPoints(e.ours, e.sleeper, weight),
        actual: e.actual,
      })),
    );
  }

  return pairRate(tally, "all");
}

/**
 * The weight with the best pair accuracy over these slates. Ties go to the
 * smaller weight, which keeps a flat curve from reading as a preference
 * for Sleeper.
 */
export function fitBlendWeight(
  slates: BlendEntry[][],
  candidates: readonly number[] = BLEND_WEIGHTS,
): number {
  let best = candidates[0]!;
  let bestRate = -Infinity;

  for (const weight of candidates) {
    const rate = pairRateAt(slates, weight);

    if (Number.isNaN(rate)) {
      continue;
    }

    if (rate > bestRate) {
      best = weight;
      bestRate = rate;
    }
  }

  return best;
}
