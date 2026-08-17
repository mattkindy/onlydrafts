import { describe, expect, it } from "vitest";
import { forGame, LEAGUE_PLAYS, type GameContext } from "./situationalWeek.js";

const TEAM = { plays: LEAGUE_PLAYS };
const PLAIN: GameContext = { favouredBy: 0, total: 45, wind: 0, opponent: 1 };
const week = (over: Partial<GameContext> = {}) => forGame(TEAM, { ...PLAIN, ...over });

describe("bending a week to the game in front of it", () => {
  it("changes nothing in an average game", () => {
    expect(week().plays.openField).toBeCloseTo(LEAGUE_PLAYS.openField, 6);
    expect(week().plays.nearGoal).toBeCloseTo(LEAGUE_PLAYS.nearGoal, 6);
  });

  it("gives a favourite more of the open field than an underdog", () => {
    expect(week({ favouredBy: 10 }).plays.openField)
      .toBeGreaterThan(week({ favouredBy: -10 }).plays.openField);
  });

  it("puts an underdog in more third and longs", () => {
    expect(week({ favouredBy: -10 }).plays.thirdAndLong)
      .toBeGreaterThan(week({ favouredBy: 10 }).plays.thirdAndLong);
  });

  it("gets everyone near the goal more often in a shootout", () => {
    expect(week({ total: 54 }).plays.nearGoal)
      .toBeGreaterThan(week({ total: 36 }).plays.nearGoal);
  });

  it("leaves a team stuck in third and long in a gale", () => {
    expect(week({ wind: 22 }).plays.thirdAndLong)
      .toBeGreaterThan(week({ wind: 4 }).plays.thirdAndLong);
  });

  it("ignores a breeze", () => {
    expect(week({ wind: 6 }).plays.thirdAndLong)
      .toBeCloseTo(week().plays.thirdAndLong, 6);
  });

  it("hands out more chances against a soft defence", () => {
    expect(week({ opponent: 1.2 }).plays.nearGoal)
      .toBeGreaterThan(week({ opponent: 0.8 }).plays.nearGoal);
  });
});
