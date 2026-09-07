/**
 * Correcting Sleeper's weekly projection before anything is mixed with it.
 *
 * Sleeper is high at the top of the slate: on 2025 it gave quarterbacks 19.5
 * a game against the 17.3 they scored, while our own number is within four
 * tenths in every band. The correction is a line per position, actual
 * against projected, fit by least squares on seasons the test year cannot
 * see.
 *
 * It fixes the level and nothing else. Within a position a rising line keeps
 * every man where Sleeper put him, so the corrected number cannot win a
 * start/sit call the raw one lost. What it can move is the mix with our own
 * number, and on the pair bench that came out level.
 */

export interface CalibrationEntry {
  position: string;
  sleeper: number;
  actual: number;
}

export interface CalibrationLine {
  intercept: number;
  slope: number;
}

/** below this a position has too few weeks to fit a line worth trusting */
export const MIN_CALIBRATION_ROWS = 200;

export const IDENTITY_LINE: CalibrationLine = { intercept: 0, slope: 1 };

export type SleeperCalibration = Map<string, CalibrationLine>;

function fitLine(rows: CalibrationEntry[]): CalibrationLine {
  const n = rows.length;
  const meanX = rows.reduce((s, r) => s + r.sleeper, 0) / n;
  const meanY = rows.reduce((s, r) => s + r.actual, 0) / n;
  let covariance = 0;
  let variance = 0;

  for (const row of rows) {
    covariance += (row.sleeper - meanX) * (row.actual - meanY);
    variance += (row.sleeper - meanX) ** 2;
  }

  if (variance === 0) {
    return IDENTITY_LINE;
  }

  const slope = covariance / variance;

  return { intercept: meanY - slope * meanX, slope };
}

/** a position with too little behind it keeps Sleeper's number as it is */
export function fitSleeperCalibration(
  rows: CalibrationEntry[],
  positions: readonly string[],
): SleeperCalibration {
  const lines: SleeperCalibration = new Map();

  for (const position of positions) {
    const mine = rows.filter((r) => r.position === position);

    if (mine.length < MIN_CALIBRATION_ROWS) {
      lines.set(position, IDENTITY_LINE);
      continue;
    }

    lines.set(position, fitLine(mine));
  }

  return lines;
}

export interface CalibrationBand {
  name: string;
  min: number;
  max: number;
}

/** where a projection lands, which is what the bias is read against */
export const CALIBRATION_BANDS: readonly CalibrationBand[] = [
  { name: "0-5", min: 0, max: 5 },
  { name: "5-10", min: 5, max: 10 },
  { name: "10-15", min: 10, max: 15 },
  { name: "15-20", min: 15, max: 20 },
  { name: "20+", min: 20, max: Infinity },
];

export interface BandMeans {
  weeks: number;
  projected: number;
  actual: number;
}

/** what a method said against what was scored, by the level it said */
export function bandMeans(
  rows: { projected: number; actual: number }[],
  bands: readonly CalibrationBand[] = CALIBRATION_BANDS,
): Map<string, BandMeans> {
  const means = new Map<string, BandMeans>(
    bands.map((b) => [b.name, { weeks: 0, projected: 0, actual: 0 }]),
  );

  for (const row of rows) {
    const band = bands.find(
      (b) => row.projected >= b.min && row.projected < b.max,
    );

    if (!band) {
      continue;
    }

    const cell = means.get(band.name)!;
    cell.weeks += 1;
    cell.projected += row.projected;
    cell.actual += row.actual;
  }

  for (const cell of means.values()) {
    if (cell.weeks === 0) {
      continue;
    }

    cell.projected /= cell.weeks;
    cell.actual /= cell.weeks;
  }

  return means;
}

/**
 * Nobody is projected to lose points, so the corrected number is floored at
 * zero rather than left to go negative where the line crosses.
 */
export function calibrate(
  calibration: SleeperCalibration,
  position: string,
  points: number,
): number {
  const line = calibration.get(position) ?? IDENTITY_LINE;

  return Math.max(0, line.intercept + line.slope * points);
}
