export function rmse(predicted: number[], actual: number[]): number {
  if (predicted.length !== actual.length || predicted.length === 0) {
    throw new Error(
      `rmse needs two equal-length non-empty arrays, got ${predicted.length} and ${actual.length}`,
    );
  }

  let sum = 0;

  for (let i = 0; i < predicted.length; i++) {
    const diff = (predicted[i] ?? 0) - (actual[i] ?? 0);
    sum += diff * diff;
  }

  return Math.sqrt(sum / predicted.length);
}

function ranks(values: number[]): number[] {
  const indexed = values.map((value, index) => ({ value, index }));
  indexed.sort((a, b) => a.value - b.value);

  const result = new Array<number>(values.length);
  let i = 0;

  while (i < indexed.length) {
    // ties share the average of the ranks they occupy
    let j = i;

    while (j + 1 < indexed.length && indexed[j + 1]!.value === indexed[i]!.value) {
      j++;
    }

    const averageRank = (i + j) / 2 + 1;

    for (let k = i; k <= j; k++) {
      result[indexed[k]!.index] = averageRank;
    }

    i = j + 1;
  }

  return result;
}

/**
 * Spearman rank correlation. Draft decisions are orderings, so this is
 * the headline metric: it rewards getting players in the right order
 * even when the point estimates are off.
 */
export function spearman(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length < 2) {
    throw new Error(
      `spearman needs two equal-length arrays of at least 2, got ${a.length} and ${b.length}`,
    );
  }

  const ra = ranks(a);
  const rb = ranks(b);

  const meanA = ra.reduce((s, v) => s + v, 0) / ra.length;
  const meanB = rb.reduce((s, v) => s + v, 0) / rb.length;

  let cov = 0;
  let varA = 0;
  let varB = 0;

  for (let i = 0; i < ra.length; i++) {
    const da = (ra[i] ?? 0) - meanA;
    const db = (rb[i] ?? 0) - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }

  if (varA === 0 || varB === 0) {
    return 0;
  }

  return cov / Math.sqrt(varA * varB);
}

/**
 * Spearman treats getting pick 3 right and pick 160 right as the same
 * job, and a drafter does not. These two ask what the order was for.
 *
 * Both take what the board said a man was worth and what he turned out
 * to be worth, and both want value over replacement rather than points,
 * since a man who scores less than the waiver wire is worth nothing
 * whatever he scores.
 */

/** what a man is worth to a drafter, which is nothing below the wire */
const worth = (value: number) => Math.max(0, value);

/**
 * The share of the value available in the first so many picks that this
 * order actually collected. One means it took the best men there were.
 *
 * The cutoff does the weighting: a man the board put at 200 never comes
 * into it, however wrong he was.
 */
export function caught(said: number[], was: number[], picks: number): number {
  if (said.length !== was.length || said.length < 2) {
    throw new Error(
      `caught needs two equal-length arrays of at least 2, got ${said.length} and ${was.length}`,
    );
  }

  const take = Math.min(picks, said.length);
  const order = said.map((value, i) => i).sort((a, b) => said[b]! - said[a]!);
  const got = order.slice(0, take)
    .reduce((sum, i) => sum + worth(was[i] ?? 0), 0);
  const best = [...was].map(worth).sort((a, b) => b - a)
    .slice(0, take).reduce((sum, v) => sum + v, 0);

  return best > 0 ? got / best : 0;
}

/**
 * The same idea without a cliff at the cutoff: every place is worth
 * less than the one above it, the way a pick is. One means it put the
 * best men first.
 */
export function gain(said: number[], was: number[]): number {
  if (said.length !== was.length || said.length < 2) {
    throw new Error(
      `gain needs two equal-length arrays of at least 2, got ${said.length} and ${was.length}`,
    );
  }

  const discounted = (values: number[]) =>
    values.reduce((sum, v, place) => sum + worth(v) / Math.log2(place + 2), 0);
  const order = said.map((_, i) => i).sort((a, b) => said[b]! - said[a]!);
  const got = discounted(order.map((i) => was[i] ?? 0));
  const best = discounted([...was].map(worth).sort((a, b) => b - a));

  return best > 0 ? got / best : 0;
}
