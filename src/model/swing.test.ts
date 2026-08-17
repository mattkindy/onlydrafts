import { describe, expect, it } from "vitest";
import { seededRng } from "../sim/rng.js";
import { normalDraw } from "../sim/normal.js";
import { keepMean } from "./situationalWeek.js";

const drawsFor = (swing: number, count = 200000) => {
  const rng = seededRng(3);
  return Array.from({ length: count }, () => keepMean(swing, normalDraw(rng)));
};

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / values.length;

const spreadOf = (values: number[]) => {
  const mid = middle(values);
  return Math.sqrt(middle(values.map((v) => (v - mid) ** 2)));
};

describe("swinging a man's yards", () => {
  it("leaves his average where it was, however far he swings", () => {
    for (const swing of [0.3, 0.8, 1.3, 1.8]) {
      expect(middle(drawsFor(swing))).toBeCloseTo(1, 1);
    }
  });

  it("swings about as far as it is asked to", () => {
    // the clipping at nought costs a little of it, which is what
    // happens to a man who cannot lose more yards than he has
    expect(spreadOf(drawsFor(1.3))).toBeGreaterThan(0.9);
    expect(spreadOf(drawsFor(1.3))).toBeLessThan(1.3);
  });

  it("never returns a negative, since a touch cannot unhappen", () => {
    expect(Math.min(...drawsFor(1.8, 20000))).toBeGreaterThanOrEqual(0);
  });

  it("leaves a man alone who does not swing at all", () => {
    expect(keepMean(0, 2)).toBe(1);
  });
});
