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

  it("leaves a man with nothing to share out alone", () => {
    expect(sharedOut([]).length).toBe(0);
    expect(sharedOut([1, 1, 1])).toEqual([1, 1, 1]);
  });
});
