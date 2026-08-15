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
