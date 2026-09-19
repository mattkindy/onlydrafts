import { describe, expect, it } from "vitest";
import { mean, scalingFor, standardizedRow } from "./termScaling.js";

describe("putting terms on one scale", () => {
  it("centres a column on its own middle", () => {
    const scaling = scalingFor([[1, 10], [3, 30], [5, 50]]);

    expect(scaling.means).toEqual([3, 30]);
    expect(standardizedRow(scaling, [3, 30])).toEqual([1, 0, 0]);
  });

  it("divides by a spread, so two columns come back the same size", () => {
    const scaling = scalingFor([[1, 100], [3, 300], [5, 500]]);
    const [, first, second] = standardizedRow(scaling, [5, 500]);

    expect(first).toBeCloseTo(second!, 10);
  });

  it("leaves a column every row agrees on alone", () => {
    const scaling = scalingFor([[7], [7], [7]]);

    expect(scaling.deviations).toEqual([1]);
    expect(standardizedRow(scaling, [7])).toEqual([1, 0]);
  });

  it("puts the intercept's one in front of every row", () => {
    expect(standardizedRow({ means: [0], deviations: [1] }, [4]))
      .toEqual([1, 4]);
  });

  it("has no middle for nothing", () => {
    expect(mean([])).toBe(0);
  });
});
