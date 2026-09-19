import { describe, expect, it } from "vitest";
import { positionQuota, type Row } from "./sleeperBench.js";

/** a scored row with only the fields the quota reads */
const aRow = (position: string, hit: boolean): Row => ({
  cut: {
    season: 2022, week: 4, playerId: `${position}-${hit}`,
    playerName: "one player", position,
    price: 120, drafted: true,
    priceMedian: 8, priceP10: 4, priceP90: 14, priceHitRate: 0.2,
    rawWorkShare: 0.2, leverageWorkShare: 0.2, trend: 0,
    ppgSoFar: 9, gamesPlayed: 4, pickSpread: 0.2, hasPickSpread: true,
    inSeasonPpg: 9, roleLevelPpg: 9,
  },
  club: "NE",
  weeksLeft: 8,
  gamesAfter: 8,
  restOfSeasonPpg: 9,
  restOfSeasonTotal: 72,
  restOfSeasonPerGame: 9,
  hit,
  hitPerGame: hit,
  tierMargin: 0,
});

const rows = (hits: Record<string, number>): Row[] =>
  Object.entries(hits).flatMap(([position, many]) => [
    ...Array.from({ length: many }, () => aRow(position, true)),
    aRow(position, false),
  ]);

describe("positionQuota", () => {
  it("hands each position its share of the hits", () => {
    expect(positionQuota(rows({ QB: 10, RB: 20, WR: 50, TE: 20 }), 20))
      .toEqual({ QB: 2, RB: 4, WR: 10, TE: 4 });
  });

  it("gives away the whole list", () => {
    const quota = positionQuota(rows({ QB: 7, RB: 11, WR: 23, TE: 5 }), 20);

    expect(Object.values(quota).reduce((sum, one) => sum + one, 0)).toBe(20);
  });

  it("splits it evenly when nothing has hit yet", () => {
    expect(positionQuota(rows({ QB: 0, RB: 0, WR: 0, TE: 0 }), 20))
      .toEqual({ QB: 5, RB: 5, WR: 5, TE: 5 });
  });

  it("leaves a position that never pays out of the list", () => {
    expect(positionQuota(rows({ QB: 0, RB: 30, WR: 60, TE: 10 }), 20).QB)
      .toBe(0);
  });
});
