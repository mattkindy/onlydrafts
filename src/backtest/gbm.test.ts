import { describe, expect, it } from "vitest";
import { fitGbm, predictGbm } from "./gbm.js";

describe("fitGbm", () => {
  it("learns a step function", () => {
    const X = Array.from({ length: 100 }, (_, i) => [i]);
    const y = X.map(([x]) => (x! < 50 ? 1 : 5));
    const model = fitGbm(X, y, { trees: 30, depth: 2, rate: 0.3, minLeaf: 5 });

    expect(predictGbm(model, [10])).toBeCloseTo(1, 1);
    expect(predictGbm(model, [90])).toBeCloseTo(5, 1);
  });

  it("learns an interaction a linear model cannot express", () => {
    const X: number[][] = [];
    const y: number[] = [];

    for (let a = 0; a < 2; a++) {
      for (let b = 0; b < 2; b++) {
        for (let n = 0; n < 25; n++) {
          X.push([a, b]);
          y.push(a === b ? 1 : 0);
        }
      }
    }

    const model = fitGbm(X, y, { trees: 40, depth: 2, rate: 0.3, minLeaf: 5 });

    expect(predictGbm(model, [0, 0])).toBeGreaterThan(0.8);
    expect(predictGbm(model, [1, 0])).toBeLessThan(0.2);
  });

  it("respects the minimum leaf size", () => {
    const X = [[0], [1], [2]];
    const y = [0, 10, 20];
    const model = fitGbm(X, y, { trees: 5, depth: 2, rate: 0.5, minLeaf: 2 });

    expect(predictGbm(model, [0])).toBeCloseTo(predictGbm(model, [1]), 5);
  });
});
