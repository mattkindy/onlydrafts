import { describe, expect, it } from "vitest";

import {
  mixFor, normalLine, paceWeight, RATE_SHARE,
} from "./copula.ts";

const wr = mixFor({ key: "wr", position: "WR", team: "BUF" }, "MIA", 0, true);

describe("paceWeight", () => {
  it("believes none of a game nobody has played", () => {
    expect(paceWeight(0)).toBe(0);
  });

  // a whole game measures the rate as well as anything can, which is the
  // rate's share of a week and no more, and by then nothing is left to draw
  it("believes a whole game as far as the rate share goes", () => {
    expect(paceWeight(1)).toBeCloseTo(RATE_SHARE, 10);
  });

  it("stays well under the fraction played over the first half", () => {
    for (const played of [0.1, 0.2, 0.3, 0.4, 0.5]) {
      expect(paceWeight(played)).toBeLessThan(played / 5);
      expect(paceWeight(played)).toBeGreaterThan(0);
    }
  });

  it("rises with the fraction played", () => {
    expect(paceWeight(0.4)).toBeGreaterThan(paceWeight(0.2));
  });

  it("reads the rate share off the formula it was fitted with", () => {
    expect(paceWeight(0.5)).toBeCloseTo(
      (0.5 * RATE_SHARE) / (0.5 * RATE_SHARE + 1 - RATE_SHARE), 12);
  });
});

describe("normalLine", () => {
  it("leaves a player who has not kicked off on his shared number", () => {
    const line = normalLine(wr, 0.7, { played: 0, z: 2 });

    expect(line.middle).toBe(0.7);
    expect(line.width).toBe(wr.own);
  });

  it("pulls the middle toward the pace by the pace weight", () => {
    const line = normalLine(wr, 0.4, { played: 0.2, z: 2.878 });
    const weight = paceWeight(0.2);

    expect(line.middle).toBeCloseTo(
      (1 - weight) * 0.4 + weight * 2.878, 12);
  });

  it("widens the draw as the game runs down, since the caller scales it", () => {
    const early = normalLine(wr, 0, { played: 0.2, z: 1 });
    const later = normalLine(wr, 0, { played: 0.5, z: 1 });

    expect(early.width).toBeGreaterThan(wr.own);
    expect(later.width).toBeGreaterThan(early.width);
  });

  it("stops widening once a game is nearly over", () => {
    const late = normalLine(wr, 0, { played: 0.75, z: 1 });

    expect(normalLine(wr, 0, { played: 0.95, z: 1 }).width)
      .toBeCloseTo(late.width, 2);
  });
});
