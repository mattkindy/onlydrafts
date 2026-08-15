import { describe, expect, it } from "vitest";
import {
  buildResidualModel,
  outcomeQuantile,
  sampleOutcome,
  type TrainingPoint,
} from "./intervals.js";

function points(residuals: number[], predicted = 10): TrainingPoint[] {
  return residuals.map((r) => ({
    position: "WR",
    predicted,
    actual: predicted + r,
  }));
}

describe("buildResidualModel", () => {
  it("returns quantiles of the training residuals", () => {
    const model = buildResidualModel(points([-4, -2, 0, 2, 4]), 1);

    expect(outcomeQuantile(model, "WR", 10, 0)).toBe(6);
    expect(outcomeQuantile(model, "WR", 10, 0.5)).toBe(10);
    expect(outcomeQuantile(model, "WR", 10, 0.99)).toBe(14);
  });

  it("buckets by prediction level so spreads differ", () => {
    const low = points([-1, 0, 1], 3);
    const high = points([-10, 0, 10], 20);
    const model = buildResidualModel([...low, ...high], 2);

    const lowSpread =
      outcomeQuantile(model, "WR", 3, 0.99) - outcomeQuantile(model, "WR", 3, 0);
    const highSpread =
      outcomeQuantile(model, "WR", 20, 0.99) - outcomeQuantile(model, "WR", 20, 0);

    expect(lowSpread).toBe(2);
    expect(highSpread).toBe(20);
  });

  it("falls back to the prediction for unknown positions", () => {
    const model = buildResidualModel(points([-1, 1]), 1);

    expect(outcomeQuantile(model, "K", 7, 0.5)).toBe(7);
  });

  it("samples outcomes through the provided rng", () => {
    const model = buildResidualModel(points([-4, -2, 0, 2, 4]), 1);

    expect(sampleOutcome(model, "WR", 10, () => 0)).toBe(6);
    expect(sampleOutcome(model, "WR", 10, () => 0.9)).toBe(14);
  });
});
