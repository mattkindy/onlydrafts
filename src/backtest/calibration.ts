/**
 * Scoring a simulator's whole distribution against the one thing that
 * happened.
 *
 * The Brier and log scores ask whether enough weight sat on the
 * outcome that arrived. The percentile asks a separate question,
 * whether the spread is the right width: a simulator whose average is
 * right and whose spread is half as wide as the game passes the first
 * and fails the second.
 */

/**
 * How far a set of probabilities sat from what happened, summed over
 * every outcome it could have named. Nought is perfect and two is as
 * wrong as it gets, so a four way question and a two way one are not
 * comparable.
 */
export function brierScore(said: number[], happened: number): number {
  return said.reduce(
    (total, p, i) => total + (p - (i === happened ? 1 : 0)) ** 2, 0,
  );
}

/** what it cost to have said that little about what happened */
export function logScore(said: number[], happened: number): number {
  return -Math.log(Math.max(1e-6, said[happened] ?? 0));
}

/**
 * Where a real value landed inside a simulated distribution, as a
 * number between nought and one.
 *
 * The samples are counts of plays and yards rather than a continuum,
 * so ties have to be broken by a coin or the answer piles up on the
 * handful of values a drive can take and looks lumpy whatever the
 * simulator did. Spreading each tie evenly across the width it
 * occupies is what makes a calibrated simulator come out flat.
 */
export function randomisedPercentile(
  samples: number[], value: number, uniform: () => number,
): number {
  let below = 0;
  let equal = 0;

  for (const sample of samples) {
    if (sample < value) {
      below++;
    } else if (sample === value) {
      equal++;
    }
  }

  return (below + uniform() * equal) / Math.max(1, samples.length);
}

/**
 * How lumpy a set of percentiles is, against the flat line a
 * calibrated simulator produces.
 *
 * `tails` over .10 means real values keep landing outside what the
 * simulator thought possible, which is a spread that is too narrow.
 * Under .10 means the opposite, a simulator hedging wider than the
 * game ever gets.
 */
export interface Flatness {
  /** the share in each tenth, ten numbers that should all be .10 */
  deciles: number[];
  /** the share below .05 or above .95, which should be .10 */
  tails: number;
  /** the share between .40 and .60, which should be .20 */
  middle: number;
  /** how far the deciles sit from flat, summed, nought when flat */
  drift: number;
}

export function flatnessOf(percentiles: number[]): Flatness {
  const deciles = new Array(10).fill(0);

  for (const p of percentiles) {
    deciles[Math.max(0, Math.min(9, Math.floor(p * 10)))]++;
  }

  const seen = Math.max(1, percentiles.length);
  const shares = deciles.map((count: number) => count / seen);

  return {
    deciles: shares,
    tails: percentiles.filter((p) => p < 0.05 || p > 0.95).length / seen,
    middle: percentiles.filter((p) => p >= 0.4 && p <= 0.6).length / seen,
    drift: shares.reduce((total, share) => total + Math.abs(share - 0.1), 0),
  };
}

export interface CalibrationRow {
  from: number;
  to: number;
  said: number;
  happened: number;
  count: number;
}

/**
 * What was said against what followed, in bands of what was said. The
 * bands are given rather than cut evenly, because the interesting ones
 * near nought are narrow and the ones above a half are empty.
 */
export function calibrationTable(
  said: number[], happened: boolean[], edges: number[],
): CalibrationRow[] {
  const rows: CalibrationRow[] = [];

  for (let i = 0; i < edges.length - 1; i++) {
    const from = edges[i]!;
    const to = edges[i + 1]!;
    const inBand = said
      .map((p, at) => ({ p, hit: happened[at] === true }))
      .filter(({ p }) => p >= from && (p < to || (i === edges.length - 2 && p <= to)));

    rows.push({
      from,
      to,
      said: inBand.reduce((total, { p }) => total + p, 0) /
        Math.max(1, inBand.length),
      happened: inBand.filter(({ hit }) => hit).length /
        Math.max(1, inBand.length),
      count: inBand.length,
    });
  }

  return rows;
}
