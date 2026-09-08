/**
 * What a man's dealt games looked like, not only their average.
 *
 * The walk plays a fixture forty times and every reader has taken the
 * mean, so a big afternoon and a quiet one came back as the same
 * number. This describes the same runs by their spread instead, which
 * is what a floor, a ceiling and a boom chance are made of.
 *
 * Percentiles are picked by index into the sorted runs, the same way
 * the draft board's bands pick them, so the two agree on what a tenth
 * means.
 */

export interface RunSpread {
  /** how many runs went into it */
  runs: number;
  sd: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  /** share of runs over twenty points, and over thirty */
  over20: number;
  over30: number;
}

export function quantileOf(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }

  return sorted[Math.min(
    sorted.length - 1,
    Math.max(0, Math.round(p * (sorted.length - 1))),
  )]!;
}

const EMPTY: RunSpread = {
  runs: 0, sd: 0, p10: 0, p25: 0, p50: 0, p75: 0, p90: 0,
  over20: 0, over30: 0,
};

export function spreadOf(values: number[]): RunSpread {
  if (values.length === 0) {
    return { ...EMPTY };
  }

  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const share = (over: number) =>
    values.filter((v) => v > over).length / values.length;

  return {
    runs: values.length,
    sd: Math.sqrt(variance),
    p10: quantileOf(sorted, 0.1),
    p25: quantileOf(sorted, 0.25),
    p50: quantileOf(sorted, 0.5),
    p75: quantileOf(sorted, 0.75),
    p90: quantileOf(sorted, 0.9),
    over20: share(20),
    over30: share(30),
  };
}
