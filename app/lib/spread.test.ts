import { describe, expect, it } from "vitest";

import {
  normalCdf, quantileOf, weekAt, weeksFromSpread, type Spread,
} from "./spread.ts";

const points = [5, 9, 13, 18, 25];

const spread: Spread = {
  ev: 13, low: 5, q1: 9, mid: 13, q3: 18, high: 25,
};

describe("weekAt", () => {
  it("reads the five shipped figures back", () => {
    expect(weekAt(points, 0.1)).toBeCloseTo(5);
    expect(weekAt(points, 0.25)).toBeCloseTo(9);
    expect(weekAt(points, 0.5)).toBeCloseTo(13);
    expect(weekAt(points, 0.75)).toBeCloseTo(18);
    expect(weekAt(points, 0.9)).toBeCloseTo(25);
  });

  it("goes straight between them inside", () => {
    expect(weekAt(points, 0.625)).toBeCloseTo(15.5);
  });

  it("leaves the ninety-ninth week well above the ceiling", () => {
    const ceiling = weekAt(points, 0.9);
    const ninetyNine = weekAt(points, 0.99);

    expect(ninetyNine - ceiling).toBeGreaterThan(7);
  });

  it("leaves the first week well below the floor", () => {
    expect(weekAt(points, 0.01) - weekAt(points, 0.1)).toBeLessThan(-4);
  });

  it("keeps rising all the way out", () => {
    expect(weekAt(points, 0.999)).toBeGreaterThan(weekAt(points, 0.99));
    expect(weekAt(points, 0.001)).toBeLessThan(weekAt(points, 0.01));
  });
});

describe("quantileOf", () => {
  it("inverts weekAt inside the shipped figures", () => {
    for (const u of [0.15, 0.4, 0.6, 0.85]) {
      expect(quantileOf(spread, weekAt(points, u))).toBeCloseTo(u, 6);
    }
  });

  it("inverts weekAt out in the tails too", () => {
    for (const u of [0.01, 0.05, 0.95, 0.99]) {
      expect(quantileOf(spread, weekAt(points, u))).toBeCloseTo(u, 4);
    }
  });
});

describe("weeksFromSpread", () => {
  it("puts about a fifth of a man's weeks outside his shipped band", () => {
    const weeks = weeksFromSpread(spread, "somebody", 4000);
    const outside = weeks.filter((w) => w < 5 || w > 25).length;

    expect(outside / weeks.length).toBeGreaterThan(0.15);
    expect(outside / weeks.length).toBeLessThan(0.25);
  });

  it("takes the uniforms a caller supplies", () => {
    const us = [0.1, 0.5, 0.9];

    expect(weeksFromSpread(spread, "somebody", 3, us)).toEqual([5, 13, 25]);
  });
});

describe("normalCdf", () => {
  it("agrees with the normal at the quantiles weekAt extends from", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.2815515655446004)).toBeCloseTo(0.9, 5);
  });
});
