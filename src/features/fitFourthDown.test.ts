import { describe, expect, it } from "vitest";
import { distanceReach, fitFourthDown, type FourthRow } from "./fitFourthDown.js";

/** fourth downs spread along the field, going for it at one rate per distance */
const rowsAt = (toGo: number, goes: number, each = 100): FourthRow[] => {
  const rows: FourthRow[] = [];

  for (let yardline = 30; yardline <= 70; yardline++) {
    for (let i = 0; i < each; i++) {
      rows.push({
        toGo, yardline, margin: 0, secondsLeft: 1800,
        choice: i < goes * each ? "go" : "punt",
      });
    }
  }

  return rows;
};

const at = (toGo: number, yardline = 50) =>
  ({ down: 4, toGo, yardline, margin: 0, secondsLeft: 1800 });

describe("how far the distance is let out", () => {
  it("keeps a short distance to itself however far the field reaches", () => {
    expect(distanceReach(1, 3)).toBe(0);
    expect(distanceReach(3, 3)).toBe(0);
  });

  it("lets a long one out with the field", () => {
    expect(distanceReach(9, 0)).toBe(0);
    expect(distanceReach(9, 3)).toBe(2);
  });
});

describe("going for it by the distance", () => {
  const fitted = fitFourthDown([
    ...rowsAt(1, 0.75), ...rowsAt(2, 0.42), ...rowsAt(3, 0.33),
  ]);

  it("does not pool fourth and one with fourth and two or three", () => {
    expect(fitted.chances(at(1)).go).toBeCloseTo(0.75, 1);
    expect(fitted.chances(at(2)).go).toBeCloseTo(0.42, 1);
    expect(fitted.chances(at(3)).go).toBeCloseTo(0.33, 1);
  });

  it("still reaches along the field to fill a thin spot", () => {
    // one row a yard, so the exact spot alone is far short of sixty
    const thin = fitFourthDown(rowsAt(1, 0.75, 4));

    expect(thin.chances(at(1)).go).toBeCloseTo(0.75, 1);
  });
});
