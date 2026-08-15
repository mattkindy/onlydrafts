import { describe, expect, it } from "vitest";
import { rmse, spearman } from "./metrics.js";

describe("rmse", () => {
  it("is zero for a perfect prediction", () => {
    expect(rmse([1, 2, 3], [1, 2, 3])).toBe(0);
  });

  it("matches a hand-computed value", () => {
    expect(rmse([2, 4], [0, 4])).toBe(Math.sqrt(2));
  });

  it("rejects mismatched lengths", () => {
    expect(() => rmse([1], [1, 2])).toThrow();
  });
});

describe("spearman", () => {
  it("is 1 for identical orderings", () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1);
  });

  it("is -1 for reversed orderings", () => {
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1);
  });

  it("averages ranks across ties", () => {
    // ties in one array pull the correlation off 1 but keep it positive
    const r = spearman([1, 2, 2, 3], [1, 2, 3, 4]);
    expect(r).toBeGreaterThan(0.9);
    expect(r).toBeLessThan(1);
  });

  it("returns 0 when one side is constant", () => {
    expect(spearman([5, 5, 5], [1, 2, 3])).toBe(0);
  });
});
