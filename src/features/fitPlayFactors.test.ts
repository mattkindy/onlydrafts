import { describe, expect, it, vi } from "vitest";
import type { GoalSample } from "./fitPlayFactors.js";
import type { PlayState } from "../model/playFactors.js";

/**
 * The carry is read out of the environment when the module loads, so
 * both settings need their own load of it.
 */
const settleWith = async (lift: boolean) => {
  vi.resetModules();

  if (lift) {
    process.env["GOAL_LIFT"] = "1";
  } else {
    delete process.env["GOAL_LIFT"];
  }

  const loaded = await import("./fitPlayFactors.js");
  delete process.env["GOAL_LIFT"];

  return loaded.settleAtGoal;
};

const atTheFive: PlayState = {
  down: 2, toGo: 5, yardline: 5, margin: 0, secondsLeft: 900,
};

/** a pool that reaches the line twice as often as sides score from it */
const crossesTooOften: GoalSample = {
  crossShare: 0.6, gainfulShare: 0.8, scoreRate: 0.3,
};

/** and one that reaches it less often than sides score */
const crossesTooRarely: GoalSample = {
  crossShare: 0.2, gainfulShare: 0.7, scoreRate: 0.45,
};

const always = (value: number) => () => value;

describe("settleAtGoal", () => {
  it("keeps a crossing draw as often as sides score from the spot", async () => {
    const settle = await settleWith(false);

    // half the crossings are kept, since sides score half as often
    expect(settle(atTheFive, "pass", 7, always(0.49), crossesTooOften)).toBe(7);
    expect(settle(atTheFive, "pass", 7, always(0.51), crossesTooOften)).toBe(4);
  });

  it("cuts a run that crossed as well as a throw", async () => {
    const settle = await settleWith(false);

    expect(settle(atTheFive, "run", 7, always(0.51), crossesTooOften)).toBe(4);
  });

  it("keeps every crossing draw when the pool crosses too rarely", async () => {
    const settle = await settleWith(false);

    expect(settle(atTheFive, "pass", 9, always(0.99), crossesTooRarely)).toBe(9);
  });

  it("leaves a short draw where it landed with the carry off", async () => {
    const settle = await settleWith(false);

    expect(settle(atTheFive, "pass", 2, always(0.01), crossesTooRarely)).toBe(2);
  });

  it("carries a short throw up to the line with the carry on", async () => {
    const settle = await settleWith(true);

    // (0.45 - 0.2) / (0.7 - 0.2) is half the short throws
    expect(settle(atTheFive, "pass", 2, always(0.49), crossesTooRarely)).toBe(5);
    expect(settle(atTheFive, "pass", 2, always(0.51), crossesTooRarely)).toBe(2);
  });

  it("never carries a short run up, even with the carry on", async () => {
    const settle = await settleWith(true);

    expect(settle(atTheFive, "run", 2, always(0.01), crossesTooRarely)).toBe(2);
  });

  it("leaves a draw that made nothing alone", async () => {
    const settle = await settleWith(true);

    expect(settle(atTheFive, "pass", 0, always(0.01), crossesTooRarely)).toBe(0);
  });
});
