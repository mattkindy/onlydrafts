import { describe, expect, it } from "vitest";
import { LEAGUE_HABIT, teamWeekFrom } from "./teamWeek.js";

const PLAIN = { totalLine: 45, wind: 0, indoors: false };
const week = (favouredBy: number, game = PLAIN) =>
  teamWeekFrom(LEAGUE_HABIT, game, favouredBy, 22);

describe("teamWeekFrom", () => {
  it("gives a favourite's back more work than an underdog's", () => {
    expect(week(10).rushAttempts).toBeGreaterThan(week(-10).rushAttempts);
  });

  it("has the underdog throwing more", () => {
    expect(week(-10).passAttempts).toBeGreaterThan(week(10).passAttempts);
  });

  it("puts about five hand-offs between the extremes, as measured", () => {
    const gap = week(10).rushAttempts - week(-10).rushAttempts;
    expect(gap).toBeGreaterThan(2);
    expect(gap).toBeLessThan(7);
  });

  it("adds passes and plays when the game is expected to score", () => {
    const high = week(0, { ...PLAIN, totalLine: 52 });
    const low = week(0, { ...PLAIN, totalLine: 38 });

    expect(high.passAttempts).toBeGreaterThan(low.passAttempts);
    expect(high.passAttempts + high.rushAttempts)
      .toBeGreaterThan(low.passAttempts + low.rushAttempts);
  });

  it("takes passes away in a gale, but not under a roof", () => {
    const gale = week(0, { ...PLAIN, wind: 22 });
    const roofed = week(0, { totalLine: 45, wind: 22, indoors: true });

    expect(gale.passAttempts).toBeLessThan(week(0).passAttempts);
    expect(roofed.passAttempts).toBeCloseTo(week(0).passAttempts, 6);
  });

  it("ignores a breeze", () => {
    expect(week(0, { ...PLAIN, wind: 6 }).passAttempts)
      .toBeCloseTo(week(0).passAttempts, 6);
  });

  it("keeps the split sane at any line", () => {
    for (const spread of [-30, -14, 0, 14, 30]) {
      const w = week(spread);
      const share = w.passAttempts / (w.passAttempts + w.rushAttempts);
      expect(share).toBeGreaterThan(0.3);
      expect(share).toBeLessThan(0.8);
    }
  });
});
