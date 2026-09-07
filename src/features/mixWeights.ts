/**
 * Mixing several projections of the same week and choosing the shares.
 *
 * Two voices or three, the mix is a weighted average of the point totals,
 * and the shares are chosen the way the weekly bench scores: over every
 * pair of men on a slate, how often the higher number outscored the other.
 * Whoever is mixing decides what the parts are and in what order; this only
 * weighs them.
 */

import { addPairs, emptyTally, pairRate } from "../backtest/pairs.js";

export interface MixEntry {
  /** one number per voice, in the same order as the weights */
  parts: number[];
  actual: number;
}

export function mixPoints(parts: number[], weights: number[]): number {
  let total = 0;

  for (let i = 0; i < parts.length; i++) {
    total += (weights[i] ?? 0) * parts[i]!;
  }

  return total;
}

export function mixPairRate(slates: MixEntry[][], weights: number[]): number {
  const tally = emptyTally();

  for (const slate of slates) {
    addPairs(
      tally,
      slate.map((e) => ({
        predicted: mixPoints(e.parts, weights),
        actual: e.actual,
      })),
    );
  }

  return pairRate(tally, "all");
}

/**
 * The candidate with the best pair accuracy. Ties go to whichever came
 * first, so a caller who lists the plainest mix first keeps it when the
 * curve is flat rather than reading noise as a preference.
 */
export function bestMix(
  slates: MixEntry[][],
  candidates: readonly number[][],
): number[] {
  let best = candidates[0]!;
  let bestRate = -Infinity;

  for (const weights of candidates) {
    const rate = mixPairRate(slates, weights);

    if (Number.isNaN(rate) || rate <= bestRate) {
      continue;
    }

    best = weights;
    bestRate = rate;
  }

  return [...best];
}

function splitsOf(steps: number, voices: number): number[][] {
  if (voices === 1) {
    return [[steps]];
  }

  const out: number[][] = [];

  for (let taken = 0; taken <= steps; taken++) {
    for (const rest of splitsOf(steps - taken, voices - 1)) {
      out.push([taken, ...rest]);
    }
  }

  return out;
}

/**
 * Every way of splitting one whole between `voices` parts in steps of
 * `step`. The evenest split comes first, so a flat curve keeps the mix
 * that leans on nobody rather than reading noise as a preference.
 */
export function shareGrid(voices: number, step: number): number[][] {
  const steps = Math.round(1 / step);
  const even = steps / voices;
  const spread = (split: number[]) =>
    split.reduce((s, part) => s + (part - even) ** 2, 0);

  return splitsOf(steps, voices)
    .sort((a, b) => spread(a) - spread(b))
    .map((split) => split.map((part) => part / steps));
}
