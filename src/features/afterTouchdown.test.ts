import { describe, expect, it } from "vitest";
import {
  DEFAULT_AFTER_TOUCHDOWN, fitAfterTouchdown, type AfterTouchdownRow,
} from "./afterTouchdown.js";

/** a run of tries at one margin, going for two at one rate and making it at another */
const triesAt = (
  margin: number, goesFor: number, converts: number, secondsLeft = 1800, n = 100,
): AfterTouchdownRow[] => {
  const rows: AfterTouchdownRow[] = [];

  for (let i = 0; i < n; i++) {
    const two = i < goesFor * n;
    rows.push({
      margin, secondsLeft, two,
      made: two ? i < converts * n : true,
    });
  }

  return rows;
};

describe("what a side does after the six", () => {
  const fitted = fitAfterTouchdown([
    ...triesAt(-2, 0.8, 0.5), ...triesAt(-4, 0.05, 0.5), ...triesAt(6, 0.01, 0.5),
  ]);

  it("goes for two far more when it ties the game than when it does not", () => {
    expect(fitted.goesForTwo(-2, 1800)).toBeGreaterThan(0.6);
    expect(fitted.goesForTwo(-4, 1800)).toBeLessThan(0.2);
    expect(fitted.goesForTwo(6, 1800)).toBeLessThan(0.1);
  });

  it("falls back to the pooled rate off a margin it never saw", () => {
    const overall = (0.8 + 0.05 + 0.01) / 3;
    expect(fitted.goesForTwo(99, 1800)).toBeCloseTo(overall, 1);
  });

  it("keeps the conversion and extra point rates in a sensible range", () => {
    expect(fitted.convertRate).toBeGreaterThan(0.3);
    expect(fitted.convertRate).toBeLessThan(0.7);
    expect(fitted.extraPointRate).toBeGreaterThan(0.9);
  });
});

describe("late in the game, the same margin is chased harder", () => {
  it("goes for two more often down 2 with the clock almost gone", () => {
    const fitted = fitAfterTouchdown([
      ...triesAt(-2, 0.4, 0.5, 1800, 60), ...triesAt(-2, 1, 0.5, 120, 20),
    ]);

    expect(fitted.goesForTwo(-2, 100)).toBeGreaterThan(fitted.goesForTwo(-2, 1800));
  });

  it("leaves a late margin it barely saw to the pooled table for that margin", () => {
    const fitted = fitAfterTouchdown([
      ...triesAt(-2, 0.4, 0.5, 1800, 60), ...triesAt(-2, 1, 0.5, 100, 3),
    ]);

    expect(fitted.goesForTwo(-2, 100)).toBeCloseTo(0.4, 1);
  });
});

describe("the baked default", () => {
  it("keeps every rate a chance, between nothing and certain", () => {
    for (const margin of [-20, -8, -2, -1, 0, 1, 6, 12, 30]) {
      for (const secondsLeft of [1800, 200]) {
        const p = DEFAULT_AFTER_TOUCHDOWN.goesForTwo(margin, secondsLeft);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }
    }

    expect(DEFAULT_AFTER_TOUCHDOWN.convertRate).toBeGreaterThan(0.3);
    expect(DEFAULT_AFTER_TOUCHDOWN.convertRate).toBeLessThan(0.7);
    expect(DEFAULT_AFTER_TOUCHDOWN.extraPointRate).toBeGreaterThan(0.9);
  });

  it("goes for two down 2 far more than down 4", () => {
    expect(DEFAULT_AFTER_TOUCHDOWN.goesForTwo(-2, 1800))
      .toBeGreaterThan(DEFAULT_AFTER_TOUCHDOWN.goesForTwo(-4, 1800));
  });
});
