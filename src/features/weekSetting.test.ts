import { describe, expect, it } from "vitest";
import { settingLift, sharedOut, type Setting } from "./weekSetting.js";

const ordinary: Setting = { indoors: false, night: false, restDays: 7 };

describe("what the schedule says about a week", () => {
  it("leaves an ordinary Sunday afternoon alone", () => {
    for (const position of ["QB", "RB", "WR", "TE", "K", "DEF"]) {
      expect(settingLift(position, ordinary)).toBe(1);
    }
  });

  it("gives the throwing game a roof and barely moves the running game", () => {
    const roofed = { ...ordinary, indoors: true };

    expect(settingLift("QB", roofed)).toBeGreaterThan(1.04);
    expect(settingLift("WR", roofed)).toBeGreaterThan(1.04);
    expect(settingLift("RB", roofed)).toBe(1);
  });

  it("takes something off a back at night", () => {
    expect(settingLift("RB", { ...ordinary, night: true })).toBeLessThan(1);
  });

  it("stacks a roof and a night kickoff together", () => {
    const both = settingLift("WR", { ...ordinary, indoors: true, night: true });

    expect(both).toBeCloseTo(1.0510 * 0.9766, 4);
  });

  it("says nothing about a position it was never fitted for", () => {
    expect(settingLift("K", { indoors: true, night: true, restDays: 3 })).toBe(1);
  });

  /**
   * His season projection is already settled, so the schedule can only
   * move which weeks it lands in, never how much there is.
   */
  it("shares a schedule out without adding to it", () => {
    const out = sharedOut([1.05, 1.05, 0.97, 1.0, 1.0]);
    const middle = out.reduce((s, l) => s + l, 0) / out.length;

    expect(middle).toBeCloseTo(1, 10);
    expect(out[0]).toBeGreaterThan(out[2]!);
  });

  it("leaves a player with nothing to share out alone", () => {
    expect(sharedOut([]).length).toBe(0);
    expect(sharedOut([1, 1, 1])).toEqual([1, 1, 1]);
  });
});

/** a back who takes 40% of his touches through the air is a catching one */
const CATCHES = 0.4;
const RUNS = 0.1;

describe("what the forecast says about a week", () => {
  const mild = { wind: 5, temperature: 65, soaked: false };
  const blowing = { wind: 25, temperature: 65, soaked: false };
  const freezing = { wind: 5, temperature: 15, soaked: false };
  const wet = { ...mild, soaked: true };
  const under = (weather: Setting["weather"]) => ({ ...ordinary, weather });

  it("leaves a mild still dry afternoon alone", () => {
    for (const position of ["QB", "RB", "WR", "TE"]) {
      expect(settingLift(position, under(mild), CATCHES)).toBeCloseTo(1, 10);
    }
  });

  it("takes points off everyone it was fitted for when the wind gets up", () => {
    expect(settingLift("QB", under(blowing))).toBeLessThan(0.99);
    expect(settingLift("WR", under(blowing))).toBeLessThan(0.99);
    expect(settingLift("TE", under(blowing))).toBeLessThan(0.99);
    expect(settingLift("RB", under(blowing), CATCHES)).toBeLessThan(0.99);
  });

  it("costs a tight end more wind than a receiver, which is what was fitted", () => {
    expect(settingLift("TE", under(blowing)))
      .toBeLessThan(settingLift("WR", under(blowing)));
  });

  it("leaves a back who mostly runs out of the weather tables", () => {
    expect(settingLift("RB", under(blowing), RUNS)).toBe(1);
    expect(settingLift("RB", under(wet), RUNS)).toBe(1);
    expect(settingLift("RB", under(freezing), RUNS)).toBe(1);
  });

  it("does not know what a kicker does with the weather", () => {
    expect(settingLift("K", under(blowing))).toBe(1);
  });

  it("takes something off for the cold and more again for a soaking", () => {
    expect(settingLift("WR", under(freezing))).toBeLessThan(1);
    expect(settingLift("WR", under(wet)))
      .toBeLessThan(settingLift("WR", under(freezing)));
  });

  it("leaves a roof out of the weather whatever the forecast says", () => {
    const inside = { ...ordinary, indoors: true, weather: blowing };

    expect(settingLift("WR", inside)).toBeCloseTo(1.0510, 4);
  });

  /**
   * The corner term runs positive for a tight end, so a day past
   * anything the tables were fitted on used to come out as a lift.
   */
  it("never turns weather into a lift, however bad the day gets", () => {
    const awful = { wind: 90, temperature: -40, soaked: true };

    for (const position of ["QB", "WR", "TE"]) {
      expect(settingLift(position, under(awful))).toBeLessThan(1);
      expect(settingLift(position, under(awful))).toBeGreaterThanOrEqual(0.75);
    }

    expect(settingLift("RB", under(awful), CATCHES)).toBeLessThan(1);
  });

  it("says nothing at all when nobody has a forecast", () => {
    expect(settingLift("WR", ordinary)).toBe(1);
    expect(settingLift("QB", { ...ordinary, indoors: true }))
      .toBeCloseTo(1.0474, 4);
  });
});
