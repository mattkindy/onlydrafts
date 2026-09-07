import { describe, expect, it } from "vitest";
import {
  brierScore, calibrationTable, flatnessOf, logScore, randomisedPercentile,
} from "./calibration.js";

/** a repeatable stand-in for the walk's rng */
const cycling = (values: number[]) => {
  let at = 0;
  return () => values[at++ % values.length]!;
};

describe("brierScore", () => {
  it("is nought when the outcome was called with certainty", () => {
    expect(brierScore([0, 1, 0], 1)).toBe(0);
  });

  it("is two when the whole weight went on something else", () => {
    expect(brierScore([1, 0, 0], 1)).toBe(2);
  });

  it("splits evenly across a four way guess", () => {
    expect(brierScore([0.25, 0.25, 0.25, 0.25], 0)).toBeCloseTo(0.75, 10);
  });
});

describe("logScore", () => {
  it("is nought when the outcome was certain", () => {
    expect(logScore([0, 1], 1)).toBeCloseTo(0, 10);
  });

  it("is the log of an even coin when the guess was even", () => {
    expect(logScore([0.5, 0.5], 0)).toBeCloseTo(Math.log(2), 10);
  });

  it("stops short of infinity when nothing was said about the outcome", () => {
    expect(logScore([1, 0], 1)).toBeCloseTo(-Math.log(1e-6), 10);
  });
});

describe("randomisedPercentile", () => {
  it("puts a value above everything simulated at the top", () => {
    expect(randomisedPercentile([1, 2, 3, 4], 9, () => 0.5)).toBe(1);
  });

  it("puts a value below everything simulated at the bottom", () => {
    expect(randomisedPercentile([1, 2, 3, 4], 0, () => 0.5)).toBe(0);
  });

  it("spreads a tie across the width the tied value occupies", () => {
    const samples = [1, 2, 2, 2, 5];
    expect(randomisedPercentile(samples, 2, () => 0)).toBeCloseTo(0.2, 10);
    expect(randomisedPercentile(samples, 2, () => 1)).toBeCloseTo(0.8, 10);
  });

  it("comes out flat when the value is drawn from the same pool", () => {
    const samples = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const uniform = cycling([0.5]);
    const seen = samples.map((v) => randomisedPercentile(samples, v, uniform));
    expect(flatnessOf(seen).drift).toBeCloseTo(0, 10);
  });
});

describe("flatnessOf", () => {
  it("reports no drift when every tenth is equally full", () => {
    const flat = flatnessOf([0.02, 0.12, 0.22, 0.32, 0.42, 0.52, 0.62, 0.72, 0.82, 0.92]);
    expect(flat.drift).toBeCloseTo(0, 10);
    expect(flat.tails).toBeCloseTo(0.1, 10);
    expect(flat.middle).toBeCloseTo(0.2, 10);
  });

  it("shows heavy tails when the simulated spread was too narrow", () => {
    const pinched = flatnessOf([0.01, 0.02, 0.98, 0.99, 0.5]);
    expect(pinched.tails).toBeCloseTo(0.8, 10);
    expect(pinched.drift).toBeGreaterThan(1);
  });
});

describe("calibrationTable", () => {
  it("counts what followed in each band of what was said", () => {
    const rows = calibrationTable(
      [0.05, 0.08, 0.4, 0.45],
      [false, true, true, false],
      [0, 0.1, 0.5],
    );

    expect(rows[0]).toMatchObject({ count: 2, happened: 0.5 });
    expect(rows[0]!.said).toBeCloseTo(0.065, 10);
    expect(rows[1]).toMatchObject({ count: 2, happened: 0.5 });
  });

  it("keeps a value sitting on the top edge in the last band", () => {
    const rows = calibrationTable([1], [true], [0, 0.5, 1]);
    expect(rows[1]!.count).toBe(1);
  });
});
