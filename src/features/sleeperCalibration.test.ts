import { describe, expect, it } from "vitest";
import {
  bandMeans,
  calibrate,
  fitSleeperCalibration,
  IDENTITY_LINE,
  MIN_CALIBRATION_ROWS,
  type CalibrationEntry,
} from "./sleeperCalibration.js";

/** a position projected a fixed amount too high everywhere */
function overProjected(position: string, by: number): CalibrationEntry[] {
  return Array.from({ length: MIN_CALIBRATION_ROWS }, (_, i) => {
    const actual = i % 30;
    return { position, sleeper: actual + by, actual };
  });
}

describe("fitSleeperCalibration", () => {
  it("takes the bias back off a projection that runs high", () => {
    const calibration = fitSleeperCalibration(overProjected("QB", 3), ["QB"]);
    expect(calibrate(calibration, "QB", 20)).toBeCloseTo(17, 6);
    expect(calibration.get("QB")!.slope).toBeCloseTo(1, 6);
  });

  it("pulls the top back when the projection is too spread out", () => {
    const rows = Array.from({ length: MIN_CALIBRATION_ROWS }, (_, i) => {
      const actual = i % 25;
      return { position: "WR", sleeper: actual * 2, actual };
    });
    const calibration = fitSleeperCalibration(rows, ["WR"]);
    expect(calibrate(calibration, "WR", 30)).toBeCloseTo(15, 6);
  });

  it("leaves a position with too few weeks alone", () => {
    const rows = overProjected("TE", 5).slice(0, MIN_CALIBRATION_ROWS - 1);
    const calibration = fitSleeperCalibration(rows, ["TE"]);
    expect(calibration.get("TE")).toEqual(IDENTITY_LINE);
    expect(calibrate(calibration, "TE", 12)).toBe(12);
  });

  it("keeps a position it was never given at sleeper's number", () => {
    const calibration = fitSleeperCalibration(overProjected("QB", 3), ["QB"]);
    expect(calibrate(calibration, "RB", 9)).toBe(9);
  });

  it("never hands back a negative projection", () => {
    const rows = Array.from({ length: MIN_CALIBRATION_ROWS }, (_, i) => {
      const actual = i % 20;
      return { position: "RB", sleeper: actual + 10, actual };
    });
    const calibration = fitSleeperCalibration(rows, ["RB"]);
    expect(calibrate(calibration, "RB", 0)).toBe(0);
  });
});

describe("bandMeans", () => {
  it("reads the bias off each band separately", () => {
    const means = bandMeans([
      { projected: 3, actual: 3 },
      { projected: 4, actual: 5 },
      { projected: 22, actual: 18 },
      { projected: 24, actual: 20 },
    ]);
    expect(means.get("0-5")).toEqual({ weeks: 2, projected: 3.5, actual: 4 });
    expect(means.get("20+")).toEqual({ weeks: 2, projected: 23, actual: 19 });
    expect(means.get("10-15")!.weeks).toBe(0);
  });

  it("drops a projection below the first band", () => {
    expect(bandMeans([{ projected: -2, actual: 1 }]).get("0-5")!.weeks).toBe(0);
  });
});
