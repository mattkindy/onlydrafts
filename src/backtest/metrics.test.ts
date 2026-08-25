import { describe, expect, it } from "vitest";
import { rmse, spearman, caught, gain } from "./metrics.js";

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

describe("scoring a draft order rather than an ordering", () => {
  const best = [100, 80, 60, 40, 20, 0];

  it("gives a perfect order full marks", () => {
    expect(caught(best, best, 3)).toBe(1);
    expect(gain(best, best)).toBeCloseTo(1, 10);
  });

  it("does not care what the order says below the cutoff", () => {
    const said = [100, 80, 60, 1, 2, 3];
    const alsoSaid = [100, 80, 60, 3, 2, 1];

    expect(caught(said, best, 3)).toBe(caught(alsoSaid, best, 3));
  });

  /**
   * The whole point of adding these. Spearman cannot tell these two
   * apart, because each has one pair the wrong way round.
   */
  it("punishes a mistake at the top harder than one at the bottom", () => {
    const atTop = [80, 100, 60, 40, 20, 0];
    const atBottom = [100, 80, 60, 40, 0, 20];

    expect(spearman(atTop, best)).toBeCloseTo(spearman(atBottom, best), 10);
    expect(gain(atTop, best)).toBeLessThan(gain(atBottom, best));
  });

  it("counts a man below the waiver wire as worth nothing, not as a loss", () => {
    const was = [100, 80, -50, -20];
    const said = [100, 80, 10, 5];

    expect(caught(said, was, 2)).toBe(1);
    expect(caught(said, was, 4)).toBe(1);
  });

  it("gives a board that took the worst men first close to nothing", () => {
    const backwards = [0, 20, 40, 60, 80, 100];

    expect(caught(backwards, best, 3)).toBeLessThan(0.35);
    expect(gain(backwards, best)).toBeLessThan(0.8);
  });

  it("says nothing rather than dividing by it when nobody was worth anything", () => {
    expect(caught([3, 2, 1], [0, 0, 0], 2)).toBe(0);
    expect(gain([3, 2, 1], [0, 0, 0])).toBe(0);
  });

  it("refuses arrays it cannot compare", () => {
    expect(() => caught([1, 2], [1], 1)).toThrow();
    expect(() => gain([1], [1])).toThrow();
  });
});
