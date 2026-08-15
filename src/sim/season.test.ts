import { describe, expect, it } from "vitest";
import { buildResidualModel } from "../backtest/intervals.js";
import { seededRng } from "./rng.js";
import { drawWeekOutcomes, type PlayerWeek } from "./season.js";

function player(
  playerId: string,
  position: string,
  teamId: string,
): PlayerWeek {
  return { playerId, position, predicted: 10, teamId, gameKey: "g1" };
}

function correlation(a: number[], b: number[]): number {
  const meanA = a.reduce((s, x) => s + x, 0) / a.length;
  const meanB = b.reduce((s, x) => s + x, 0) / b.length;
  let cov = 0;
  let va = 0;
  let vb = 0;

  for (let i = 0; i < a.length; i++) {
    cov += (a[i]! - meanA) * (b[i]! - meanB);
    va += (a[i]! - meanA) ** 2;
    vb += (b[i]! - meanB) ** 2;
  }

  return cov / Math.sqrt(va * vb);
}

describe("drawWeekOutcomes", () => {
  const residuals = buildResidualModel(
    Array.from({ length: 500 }, (_, i) => ({
      position: ["QB", "WR", "RB"][i % 3]!,
      predicted: 10,
      actual: 10 + (i % 21) - 10,
    })),
    1,
  );

  const week = [
    player("qb", "QB", "DET"),
    player("wr", "WR", "DET"),
    player("rb", "RB", "DET"),
  ];

  function series(id: string): number[] {
    const rng = seededRng(7);
    const values: number[] = [];

    for (let i = 0; i < 4000; i++) {
      values.push(drawWeekOutcomes(week, residuals, rng).get(id)!);
    }

    return values;
  }

  it("correlates a QB with his catcher near the measured stack level", () => {
    const r = correlation(series("qb"), series("wr"));

    expect(r).toBeGreaterThan(0.15);
    expect(r).toBeLessThan(0.32);
  });

  it("leaves the RB nearly independent of the QB", () => {
    const r = correlation(series("qb"), series("rb"));

    expect(Math.abs(r)).toBeLessThan(0.1);
  });
});
