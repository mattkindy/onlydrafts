/**
 * Putting a fit's terms on one scale before it reads them.
 *
 * A depth rank runs one to four and a snap share runs nought to one, so a
 * single ridge penalty pulls hard on one and barely touches the other
 * unless both are centred and divided by their own spread. Doing it here
 * means two fits that share a penalty share the same reading of it, and a
 * weight from one can be read against a weight from the other.
 */

export interface TermScaling {
  means: number[];
  deviations: number[];
}

export const mean = (values: number[]): number =>
  values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * A term every row agrees on has no spread to divide by, and dividing by
 * nothing would hand the fit an infinity, so it is left at one.
 */
function deviation(values: number[], middle: number): number {
  if (values.length < 2) {
    return 1;
  }

  const spread = mean(values.map((value) => (value - middle) ** 2));

  return spread > 1e-12 ? Math.sqrt(spread) : 1;
}

/** the centre and spread of each column of a set of rows */
export function scalingFor(rows: number[][]): TermScaling {
  const width = rows[0]?.length ?? 0;
  const columns = Array.from({ length: width }, (_, i) =>
    rows.map((row) => row[i] ?? 0));
  const means = columns.map(mean);

  return {
    means,
    deviations: columns.map((column, i) => deviation(column, means[i] ?? 0)),
  };
}

/** one row scaled, with the intercept's one in front of it */
export const standardizedRow = (
  scaling: TermScaling, raw: number[],
): number[] => [
  1,
  ...raw.map((value, i) =>
    (value - (scaling.means[i] ?? 0)) / (scaling.deviations[i] ?? 1)),
];
