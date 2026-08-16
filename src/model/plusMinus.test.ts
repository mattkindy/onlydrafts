import { describe, expect, it } from "vitest";
import { expectedOutcome, fitPlusMinus, type Snap } from "./plusMinus.js";
import { seededRng } from "../sim/rng.js";

/**
 * Build snaps from known truths and check the fit finds them back.
 * Nobody tells the model who the good players are, and the rosters
 * overlap, so it has to separate them from who played whom.
 */
function synthetic(truth: Map<string, number>, rng: () => number, count: number): Snap[] {
  const ids = [...truth.keys()];
  const snaps: Snap[] = [];

  for (let i = 0; i < count; i++) {
    const shuffled = [...ids].sort(() => rng() - 0.5);
    const forIt = shuffled.slice(0, 5);
    const against = shuffled.slice(5, 10);
    const signal =
      forIt.reduce((s, id) => s + truth.get(id)!, 0) -
      against.reduce((s, id) => s + truth.get(id)!, 0);
    snaps.push({ forIt, against, outcome: 0.3 + signal + (rng() - 0.5) * 0.4 });
  }

  return snaps;
}

describe("fitPlusMinus", () => {
  const truth = new Map<string, number>([
    ["star", 0.10], ["good", 0.05], ["fine", 0.0],
    ["poor", -0.05], ["awful", -0.10],
    ["a", 0.02], ["b", -0.02], ["c", 0.01], ["d", -0.01],
    ["e", 0.03], ["f", -0.03], ["g", 0.0],
  ]);

  const fit = fitPlusMinus(synthetic(truth, seededRng(9), 20000), 40);

  it("ranks the men in the order they actually are", () => {
    const order = ["star", "good", "fine", "poor", "awful"];

    for (let i = 1; i < order.length; i++) {
      expect(fit.effects.get(order[i - 1]!)!).toBeGreaterThan(fit.effects.get(order[i]!)!);
    }
  });

  it("finds roughly the right size, not only the order", () => {
    expect(fit.effects.get("star")!).toBeGreaterThan(0.05);
    expect(fit.effects.get("awful")!).toBeLessThan(-0.05);
    expect(Math.abs(fit.effects.get("fine")!)).toBeLessThan(0.03);
  });

  it("recovers the average outcome", () => {
    expect(fit.baseline).toBeCloseTo(0.3, 1);
  });

  it("counts how often it saw each man", () => {
    expect(fit.snaps.get("star")).toBeGreaterThan(1000);
  });

  it("says a strong side against a weak one does better", () => {
    const strongVsWeak = expectedOutcome(fit, ["star", "good"], ["poor", "awful"]);
    const weakVsStrong = expectedOutcome(fit, ["poor", "awful"], ["star", "good"]);

    expect(strongVsWeak).toBeGreaterThan(weakVsStrong);
  });

  it("moves a man's contribution with him to a new side", () => {
    // the same eleven, except the star swaps sides
    const withHim = expectedOutcome(fit, ["star", "fine"], ["a", "b"]);
    const againstHim = expectedOutcome(fit, ["awful", "fine"], ["a", "b"]);

    expect(withHim).toBeGreaterThan(againstHim);
  });

  it("holds a man it barely saw near zero rather than guessing", () => {
    const withRare = [
      ...synthetic(truth, seededRng(3), 4000),
      { forIt: ["rare"], against: ["a"], outcome: 5 },
    ];
    const fitted = fitPlusMinus(withRare, 400);

    expect(Math.abs(fitted.effects.get("rare")!)).toBeLessThan(0.2);
  });
});
