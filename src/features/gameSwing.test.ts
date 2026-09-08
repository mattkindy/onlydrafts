import { describe, expect, it } from "vitest";
import { seededRng } from "../sim/rng.js";
import { meanSplit, rateSplit, spreadOf, type Tally } from "./gameSwing.js";

const normalDraw = (uniform: () => number) =>
  Math.sqrt(-2 * Math.log(Math.max(1e-12, uniform()))) *
  Math.cos(2 * Math.PI * uniform());

describe("splitting a rate", () => {
  it("finds no game level swing when every game draws at the same rate", () => {
    const rng = seededRng(11);
    const games: Tally[] = Array.from({ length: 600 }, () => {
      let hits = 0;

      for (let i = 0; i < 40; i++) {
        if (rng() < 0.4) {
          hits++;
        }
      }

      return { tries: 40, hits };
    });
    const split = rateSplit(games)!;

    expect(split.flips).toBeCloseTo(Math.sqrt((0.4 * 0.6) / 40), 2);
    expect(split.gameLevel).toBeLessThan(0.02);
  });

  it("recovers a rate that moves a tenth of itself from game to game", () => {
    const rng = seededRng(12);
    const games: Tally[] = Array.from({ length: 3000 }, () => {
      const rate = Math.max(0.02, Math.min(0.98, 0.4 + 0.1 * normalDraw(rng)));
      let hits = 0;

      for (let i = 0; i < 40; i++) {
        if (rng() < rate) {
          hits++;
        }
      }

      return { tries: 40, hits };
    });

    expect(rateSplit(games)!.gameLevel).toBeCloseTo(0.1, 1);
  });
});

describe("splitting an average", () => {
  it("charges a wandering mean to the draws when nothing moves the game", () => {
    const rng = seededRng(13);
    const games = Array.from({ length: 800 }, () =>
      Array.from({ length: 12 }, () => 5 + 4 * normalDraw(rng)));
    const split = meanSplit(games)!;

    expect(split.flips).toBeCloseTo(4 / Math.sqrt(12), 1);
    expect(split.gameLevel).toBeLessThan(0.5);
  });

  it("recovers a game level shift laid on top of the draws", () => {
    const rng = seededRng(14);
    const games = Array.from({ length: 3000 }, () => {
      const day = 2 * normalDraw(rng);

      return Array.from({ length: 12 }, () => 5 + day + 4 * normalDraw(rng));
    });
    const split = meanSplit(games)!;

    expect(split.gameLevel).toBeCloseTo(2, 0);
    expect(split.total).toBeCloseTo(Math.sqrt(4 + 16 / 12), 0);
  });

  it("counts each game's own length, so short games are not called swing", () => {
    const rng = seededRng(15);
    const games = Array.from({ length: 3000 }, (_, i) =>
      Array.from({ length: 2 + (i % 20) }, () => 5 + 4 * normalDraw(rng)));

    expect(meanSplit(games)!.gameLevel).toBeLessThan(0.6);
  });
});

describe("guards", () => {
  it("says nothing about a handful of games", () => {
    expect(rateSplit([{ tries: 10, hits: 3 }])).toBeUndefined();
    expect(meanSplit([[1, 2, 3]])).toBeUndefined();
  });

  it("says nothing when no game had more than one draw", () => {
    expect(meanSplit([[1], [2], [3], [4], [5]])).toBeUndefined();
  });

  it("matches the plain spread when every game is one number", () => {
    const games: Tally[] = [
      { tries: 1000000, hits: 100000 }, { tries: 1000000, hits: 300000 },
      { tries: 1000000, hits: 200000 }, { tries: 1000000, hits: 400000 },
    ];

    expect(rateSplit(games)!.total).toBeCloseTo(spreadOf([0.1, 0.3, 0.2, 0.4]), 4);
  });
});
