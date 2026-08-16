import { describe, expect, it } from "vitest";
import { projectRest, toDateWeight } from "./restOfSeason.js";

describe("toDateWeight", () => {
  it("ignores a season that has not started", () => {
    expect(toDateWeight(0)).toBe(0);
  });

  it("rises as the games pile up", () => {
    const weights = [1, 2, 4, 6, 8, 10, 12].map(toDateWeight);

    for (let i = 1; i < weights.length; i++) {
      expect(weights[i]).toBeGreaterThan(weights[i - 1]!);
    }
  });

  it("never lets the season so far take over completely", () => {
    expect(toDateWeight(17)).toBeLessThan(0.9);
    expect(toDateWeight(100)).toBeLessThan(0.9);
  });

  it("still leans on the projection through the first month", () => {
    expect(toDateWeight(2)).toBeLessThan(0.5);
    expect(toDateWeight(4)).toBeLessThanOrEqual(0.5);
  });
});

describe("projectRest", () => {
  it("returns the projection before a snap is played", () => {
    expect(projectRest({ preseason: 14, toDate: 0, games: 0 })).toBe(14);
  });

  it("lands between the two views", () => {
    const rest = projectRest({ preseason: 10, toDate: 20, games: 6 });

    expect(rest).toBeGreaterThan(10);
    expect(rest).toBeLessThan(20);
  });

  it("pulls a hot start most of the way back in September", () => {
    // 6 points projected, 20 so far after two games: expect nearer 6
    const rest = projectRest({ preseason: 6, toDate: 20, games: 2 });

    expect(rest).toBeLessThan(13);
  });

  it("trusts the same hot run much more by December", () => {
    const early = projectRest({ preseason: 6, toDate: 20, games: 2 });
    const late = projectRest({ preseason: 6, toDate: 20, games: 12 });

    expect(late).toBeGreaterThan(early);
    expect(late).toBeGreaterThan(17);
  });
});
