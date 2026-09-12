import { describe, expect, it } from "vitest";

import { readSlate, slateUnder } from "./slate.ts";

const built = readSlate({
  season: 2026,
  week: 1,
  perCatch: 0.5,
  players: [{
    name: "Ja'Marr Chase", position: "WR", team: "CIN", opponent: "v TB",
    ours: 17, sleeper: 17, average: 17, floor: 9, ceiling: 28, q1: 12, q3: 22,
    catches: 6,
  }, {
    name: "Joe Burrow", position: "QB", team: "CIN", opponent: "v TB",
    ours: 18, sleeper: null, average: 18, floor: 10, ceiling: 27,
    catches: 0,
  }],
});

describe("slateUnder", () => {
  it("moves every point figure by the catch difference times his catches", () => {
    const ppr = slateUnder(built, 1);
    const chase = ppr.rows[0]!;

    expect(chase.ours).toBe(20);
    expect(chase.sleeper).toBe(20);
    expect(chase.blend).toBe(20);
    expect(chase.floor).toBe(12);
    expect(chase.q1).toBe(15);
    expect(chase.q3).toBe(25);
    expect(chase.ceiling).toBe(31);
    expect(ppr.perCatch).toBe(1);
  });

  it("takes points off for a league paying less than the build did", () => {
    const standard = slateUnder(built, 0);

    expect(standard.rows[0]!.blend).toBe(14);
  });

  it("leaves a man with no catches, and a missing figure, alone", () => {
    const burrow = slateUnder(built, 1).rows[1]!;

    expect(burrow.ours).toBe(18);
    expect(burrow.sleeper).toBeNull();
    expect(burrow.q1).toBeUndefined();
  });

  it("returns the same slate when the league pays what the build paid", () => {
    expect(slateUnder(built, 0.5)).toBe(built);
  });

  it("reads a slate written before the build said what a catch paid as half", () => {
    const older = readSlate({ season: 2025, week: 10, players: [] });

    expect(older.perCatch).toBe(0.5);
  });
});
