import { describe, expect, it } from "vitest";
import { fitRidge, predictRidge } from "./ridge.js";

describe("fitRidge", () => {
  it("recovers weights of an exact linear system with small lambda", () => {
    const X = [
      [1, 0, 0],
      [1, 1, 0],
      [1, 0, 1],
      [1, 1, 1],
    ];
    const y = X.map((row) => 2 + 3 * row[1]! - row[2]!);

    const w = fitRidge(X, y, 1e-9);

    expect(w[0]).toBeCloseTo(2, 5);
    expect(w[1]).toBeCloseTo(3, 5);
    expect(w[2]).toBeCloseTo(-1, 5);
  });

  it("shrinks weights toward zero as lambda grows", () => {
    const X = [
      [1, 1],
      [1, 2],
      [1, 3],
    ];
    const y = [2, 4, 6];

    const loose = fitRidge(X, y, 1e-9);
    const tight = fitRidge(X, y, 100);

    expect(Math.abs(tight[1]!)).toBeLessThan(Math.abs(loose[1]!));
  });

  it("rejects mismatched shapes", () => {
    expect(() => fitRidge([[1]], [1, 2], 0.1)).toThrow();
  });
});

describe("predictRidge", () => {
  it("computes the dot product", () => {
    expect(predictRidge([2, 3], [1, 4])).toBe(14);
  });
});
