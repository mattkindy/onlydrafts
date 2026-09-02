import { describe, expect, it } from "vitest";
import { preSnapFlag } from "./driveFromFactors.js";
import type { EndingRules } from "./driveFromFactors.js";

const rules = (flags: Partial<EndingRules>): EndingRules => ({
  kickSucceeds: () => 1,
  puntLands: () => 50,
  turnoverRate: () => 0,
  penaltyFirstDown: 0,
  penaltyYards: () => 10,
  maxPlays: 20,
  ...flags,
});

const always = () => 0;
const never = () => 1;

describe("a flag before the snap", () => {
  it("sets the offence back and replays the down", () => {
    const state = { down: 2, toGo: 7, yardline: 60, margin: 0, secondsLeft: 900 };
    const flag = preSnapFlag(
      state, rules({ offenceFlag: 1, offenceFlagYards: () => 10 }), always,
    );

    expect(flag).toBe("offence");
    expect(state).toMatchObject({ down: 2, toGo: 17, yardline: 70 });
  });

  it("sets the offence back only half the distance to its own goal", () => {
    const state = { down: 1, toGo: 10, yardline: 96, margin: 0, secondsLeft: 900 };
    preSnapFlag(state, rules({ offenceFlag: 1, offenceFlagYards: () => 10 }), always);

    expect(state).toMatchObject({ down: 1, toGo: 12, yardline: 98 });
  });

  it("moves the ball five for a defensive one and keeps the down", () => {
    const state = { down: 3, toGo: 8, yardline: 40, margin: 0, secondsLeft: 900 };
    const flag = preSnapFlag(state, rules({ defenceFlag: 1 }), always);

    expect(flag).toBe("defence");
    expect(state).toMatchObject({ down: 3, toGo: 3, yardline: 35 });
  });

  it("hands over a first down when the chains were within five", () => {
    const state = { down: 3, toGo: 4, yardline: 40, margin: 0, secondsLeft: 900 };
    preSnapFlag(state, rules({ defenceFlag: 1 }), always);

    expect(state).toMatchObject({ down: 1, toGo: 10, yardline: 35 });
  });

  it("is nothing when the draw misses or the rules have no flags", () => {
    const state = { down: 1, toGo: 10, yardline: 50, margin: 0, secondsLeft: 900 };

    expect(preSnapFlag(state, rules({ offenceFlag: 0.04, defenceFlag: 0.006 }), never))
      .toBeUndefined();
    expect(preSnapFlag(state, rules({}), always)).toBeUndefined();
    expect(state).toMatchObject({ down: 1, toGo: 10, yardline: 50 });
  });
});
