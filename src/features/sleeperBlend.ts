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

import { bestMix, type MixEntry } from "./mixWeights.js";

export interface BlendEntry {
  ours: number;
  sleeper: number;
  actual: number;
}

export const BLEND_WEIGHTS: readonly number[] = Array.from(
  { length: 21 },
  (_, i) => i / 20,
);

/**
 * What the start/sit tools rank by. The fitted weight comes out near a
 * half on both test seasons and the curve around it is flat, so an even
 * average is what ships rather than a number that moves with the fit.
 * Taking Sleeper's level bias off first was tried and left the pair
 * accuracy where it was, on both seasons.
 */
export const SHIPPED_BLEND_WEIGHT = 0.5;

/**
 * Sleeper gives a quarterback about three points a week more than he
 * scores, on both test seasons, and no other position more than half a
 * point. Taking the three off before the blend wins a quarter of a point
 * of error at quarterback and leaves every other position where it was.
 * A per-position bias fitted on the other season did no better. See
 * scripts/README.md.
 */
export const SLEEPER_QB_BIAS = 3;

/** Sleeper's number with his level bias off, which is what the blend reads */
export function debiasedSleeper(position: string, points: number): number {
  return position === "QB" ? points - SLEEPER_QB_BIAS : points;
}

/**
 * How often Sleeper had the better of it when the two projections were
 * three points or more apart, over the 2024 and 2025 slates.
 */
export const WIDE_SPLIT_SLEEPER_RATE = 0.55;

/** a gap this wide is worth telling the reader about */
export const WIDE_SPLIT_POINTS = 3;

export function blendPoints(
  ours: number,
  sleeper: number,
  weight: number,
): number {
  return (1 - weight) * ours + weight * sleeper;
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
  const entries: MixEntry[][] = slates.map((slate) =>
    slate.map((e) => ({ parts: [e.ours, e.sleeper], actual: e.actual })),
  );
  const ordered = [...candidates].sort((a, b) => a - b);
  const best = bestMix(
    entries,
    ordered.map((weight) => [1 - weight, weight]),
  );

  return best[1]!;
}
