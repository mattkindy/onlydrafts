import { describe, expect, it } from "vitest";
import {
  afterTeamWeek, carryToNextSeason, expectTeamWeek, unknownTeam, TEAM_DEFAULTS,
} from "./teamState.js";

const NEUTRAL = TEAM_DEFAULTS.neutralTotal;

describe("what an offence is worth, carried forward", () => {
  it("expects a league average team to score the league average", () => {
    expect(expectTeamWeek(unknownTeam(), NEUTRAL))
      .toBeCloseTo(TEAM_DEFAULTS.leagueMean, 6);
  });

  it("expects more from a game the market thinks will score", () => {
    expect(expectTeamWeek(unknownTeam(), 54))
      .toBeGreaterThan(expectTeamWeek(unknownTeam(), 38));
  });

  it("thinks better of a team that beats what was expected", () => {
    const after = afterTeamWeek(unknownTeam(), 70, NEUTRAL);
    expect(after.mean).toBeGreaterThan(0);
  });

  it("gets surer of a team the more it watches", () => {
    let belief = unknownTeam();
    const first = belief.variance;

    for (let week = 0; week < 8; week++) {
      belief = afterTeamWeek(belief, 50, NEUTRAL);
    }

    expect(belief.variance).toBeLessThan(first);
  });

  it("moves less on a good afternoon once it knows a team", () => {
    let watched = unknownTeam();

    for (let week = 0; week < 10; week++) {
      watched = afterTeamWeek(watched, 45, NEUTRAL);
    }

    const newcomerMove = afterTeamWeek(unknownTeam(), 75, NEUTRAL).mean;
    const watchedMove = afterTeamWeek(watched, 75, NEUTRAL).mean - watched.mean;

    expect(watchedMove).toBeLessThan(newcomerMove);
  });

  it("does not credit an offence for a shootout", () => {
    // scoring 55 in a game expected to reach 56 is not a good day
    const inShootout = afterTeamWeek(unknownTeam(), 55, 56);
    const inMud = afterTeamWeek(unknownTeam(), 55, 36);

    expect(inShootout.mean).toBeLessThan(inMud.mean);
  });

  it("comes into a new season less sure and closer to average", () => {
    let belief = unknownTeam();

    for (let week = 0; week < 17; week++) {
      belief = afterTeamWeek(belief, 62, NEUTRAL);
    }

    const next = carryToNextSeason(belief);

    expect(Math.abs(next.mean)).toBeLessThan(Math.abs(belief.mean));
    expect(next.variance).toBeGreaterThan(belief.variance);
  });
});
