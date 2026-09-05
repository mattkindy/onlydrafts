import { describe, expect, it, vi } from "vitest";
import type { CountedPlays, GoalSample, PlayRow } from "./fitPlayFactors.js";
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

/** the counting reads the flag once at load, so each setting reloads it */
const countWith = async (keepsWaste: boolean) => {
  vi.resetModules();

  if (keepsWaste) {
    process.env["POOL_WASTE"] = "1";
  } else {
    delete process.env["POOL_WASTE"];
  }

  const loaded = await import("./fitPlayFactors.js");
  delete process.env["POOL_WASTE"];

  return loaded.countPlays;
};

const aThrow = (player: string, yards: number): PlayRow => ({
  offence: "NE", defence: "NYJ", down: 1, toGo: 10, yardline: 60,
  margin: 0, secondsLeft: 1800, call: "pass", yards, touchdown: 0,
  player, airYards: 8, caught: yards > 0,
});

const depthPool = (counted: CountedPlays) =>
  [...counted.cells.values()]
    .flatMap((cell) => [...cell.byDepth.values()].flat());

describe("the pools kept by depth", () => {
  it("leaves out the sacks and the balls thrown away", async () => {
    const countPlays = await countWith(false);
    const counted = countPlays([aThrow("Diggs", 12), aThrow("", -7)]);

    expect(depthPool(counted).every((yards) => yards === 12)).toBe(true);
    // and the pool over the state itself still has the sack in it
    expect([...counted.cells.values()].some((cell) => cell.yards.includes(-7)))
      .toBe(true);
  });

  it("keeps them with the flag set", async () => {
    const countPlays = await countWith(true);
    const counted = countPlays([aThrow("Diggs", 12), aThrow("", -7)]);

    expect(depthPool(counted)).toContain(-7);
  });
});

// two backs at the four, one reaching the line on two runs in three
// and the other on one in three, where sides score half the time
const aCarry = (player: string, yardline: number, yards: number): PlayRow => ({
  offence: "NE", defence: "NYJ", down: 1, toGo: yardline, yardline,
  margin: 0, secondsLeft: 1800, call: "run", yards,
  touchdown: yards >= yardline ? 1 : 0, player,
});

const nearTheGoal = (): PlayRow[] => {
  const rows: PlayRow[] = [];

  for (let i = 0; i < 60; i++) {
    const yardline = 4 + (i % 3);
    rows.push(aCarry("Hare", yardline, i % 3 === 2 ? 1 : 6));
    rows.push(aCarry("Tortoise", yardline, i % 3 === 2 ? 6 : 1));
  }

  return rows;
};

/** the same seeded draw every time, so the two settings are comparable */
const steady = () => {
  let seed = 7;

  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;

    return seed / 0x7fffffff;
  };
};

const scoresAtTheFour = async (cutsHisOwn: boolean) => {
  vi.resetModules();

  if (cutsHisOwn) {
    process.env["GOAL_CUT_HIS_OWN"] = "1";
  } else {
    delete process.env["GOAL_CUT_HIS_OWN"];
  }

  const loaded = await import("./fitPlayFactors.js");
  delete process.env["GOAL_CUT_HIS_OWN"];

  const rows = nearTheGoal();
  const factors = loaded.fitPlayFactors(rows, loaded.FACTOR_DEFAULTS, {
    plays: loaded.storePlays(rows),
  });
  const state: PlayState = {
    down: 1, toGo: 4, yardline: 4, margin: 0, secondsLeft: 1800,
  };
  const uniform = steady();

  return (player: string) => {
    let scored = 0;

    for (let i = 0; i < 4000; i++) {
      const own = factors.hisOwnPlay?.(state, "run", player, uniform);

      if (own && own.yards >= state.yardline) {
        scored++;
      }
    }

    return scored / 4000;
  };
};

describe("a man's own draw near the goal", () => {
  it("keeps the two backs apart, cut by the one factor the spot needs", async () => {
    const scores = await scoresAtTheFour(false);

    expect(scores("Hare")).toBeGreaterThan(0.6);
    expect(scores("Tortoise")).toBeLessThan(0.4);
  });

  it("holds the better one to the league rate when he is cut by his own", async () => {
    const scores = await scoresAtTheFour(true);

    expect(scores("Hare")).toBeLessThan(0.56);
    expect(scores("Hare")).toBeGreaterThan(0.44);
    expect(scores("Tortoise")).toBeLessThan(0.4);
  });
});

/**
 * A back who reaches the line from the thirty on half his carries, at
 * a score where everybody gains far less than they do at other scores,
 * so the situation tilt comes out under one.
 */
const atTheThirty = (): PlayRow[] => {
  const carry = (player: string, margin: number, yards: number): PlayRow => ({
    offence: "NE", defence: "NYJ", down: 1, toGo: 10, yardline: 30, margin,
    secondsLeft: 1800, call: "run", yards,
    touchdown: yards >= 30 ? 1 : 0, player,
  });
  const rows: PlayRow[] = [];

  for (let i = 0; i < 40; i++) {
    rows.push(carry("Bolt", 0, i % 2 === 0 ? 30 : 2));
  }

  for (let i = 0; i < 100; i++) {
    rows.push(carry("Slug", 0, 1));
  }

  for (let i = 0; i < 400; i++) {
    rows.push(carry("Slug", -20, 12));
  }

  return rows;
};

const crossesFromTheThirty = async (tiltsTakeScores: boolean) => {
  vi.resetModules();

  if (tiltsTakeScores) {
    process.env["TILTS_TAKE_SCORES"] = "1";
  } else {
    delete process.env["TILTS_TAKE_SCORES"];
  }

  const loaded = await import("./fitPlayFactors.js");
  delete process.env["TILTS_TAKE_SCORES"];

  const rows = atTheThirty();
  const factors = loaded.fitPlayFactors(rows, loaded.FACTOR_DEFAULTS, {
    plays: loaded.storePlays(rows),
  });
  const state: PlayState = {
    down: 1, toGo: 10, yardline: 30, margin: 0, secondsLeft: 1800,
  };
  const uniform = steady();
  let crossed = 0;

  for (let i = 0; i < 4000; i++) {
    const own = factors.hisOwnPlay?.(state, "run", "Bolt", uniform);

    if (own && own.yards >= state.yardline) {
      crossed++;
    }
  }

  return crossed / 4000;
};

describe("a man's own draw out in the field", () => {
  it("keeps a sampled play that reached the goal line", async () => {
    expect(await crossesFromTheThirty(false)).toBeGreaterThan(0.45);
  });

  it("lets the tilts take it back with the flag set", async () => {
    expect(await crossesFromTheThirty(true)).toBeLessThan(0.05);
  });
});
