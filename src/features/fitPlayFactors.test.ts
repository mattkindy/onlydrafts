import { describe, expect, it, vi } from "vitest";
import type { CountedPlays, GoalSample, PlayRow } from "./fitPlayFactors.js";
import type { PlayState } from "../model/playFactors.js";
import { seededRng } from "../sim/rng.js";

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

// Busy takes four carries in five and Spare the fifth, from the same
// spot every time, so their leanings are both one and the only thing
// that can move their shares is where the level comes from.
const sameSpot = (player: string): PlayRow => ({
  offence: "NE", defence: "NYJ", down: 1, toGo: 10, yardline: 60,
  margin: 0, secondsLeft: 1800, call: "run", yards: 4, touchdown: 0, player,
});

const carriesAtMidfield = async (fromCalls: string | undefined) => {
  vi.resetModules();

  if (fromCalls) {
    process.env["FROM_CALLS"] = fromCalls;
  } else {
    delete process.env["FROM_CALLS"];
  }

  const loaded = await import("./fitPlayFactors.js");
  delete process.env["FROM_CALLS"];

  const rows: PlayRow[] = [];

  for (let i = 0; i < 100; i++) {
    rows.push(sameSpot(i % 5 === 0 ? "Spare" : "Busy"));
  }

  const factors = loaded.fitPlayFactors(rows, loaded.FACTOR_DEFAULTS, {
    // August prices the two of them the same
    split: new Map([
      ["Busy", { carries: 0.2, targets: 0 }],
      ["Spare", { carries: 0.2, targets: 0 }],
    ]),
  });
  const state: PlayState = {
    down: 1, toGo: 10, yardline: 60, margin: 0, secondsLeft: 1800,
  };

  return factors.goesTo(state, "run", ["Busy", "Spare"]);
};

describe("the level of who gets the ball", () => {
  it("splits two men the projection prices the same evenly", async () => {
    const shares = await carriesAtMidfield(undefined);

    expect(shares.get("Busy")).toBeCloseTo(0.5, 2);
    expect(shares.get("Spare")).toBeCloseTo(0.5, 2);
  });

  it("hands the busier man the difference with FROM_CALLS all the way up",
    async () => {
      const shares = await carriesAtMidfield("1");

      expect(shares.get("Busy")).toBeCloseTo(0.8, 2);
      expect(shares.get("Spare")).toBeCloseTo(0.2, 2);
    });

  it("moves him half as far in the log at a half", async () => {
    const shares = await carriesAtMidfield("0.5");

    // the geometric middle of an even split and a four to one
    expect(shares.get("Busy")).toBeCloseTo(2 / 3, 2);
  });
});

/**
 * Busy's cut of the work in each of a run of games, asked for twice a
 * game from the same spot. A cut drawn per snap rather than per game
 * would come back as a pair that disagrees.
 */
const busyOverGames = async (width: string, games: number) => {
  vi.resetModules();
  process.env["GAME_SHARE_RUN"] = width;
  process.env["GAME_SHARE_PASS"] = width;
  const loaded = await import("./fitPlayFactors.js");
  delete process.env["GAME_SHARE_RUN"];
  delete process.env["GAME_SHARE_PASS"];

  const rows: PlayRow[] = [];

  for (let i = 0; i < 100; i++) {
    rows.push(sameSpot(i % 5 === 0 ? "Spare" : "Busy"));
  }

  const factors = loaded.fitPlayFactors(rows, loaded.FACTOR_DEFAULTS, {
    split: new Map([
      ["Busy", { carries: 0.2, targets: 0 }],
      ["Spare", { carries: 0.2, targets: 0 }],
    ]),
  });
  const midfield: PlayState = {
    down: 1, toGo: 10, yardline: 60, margin: 0, secondsLeft: 1800,
  };
  const askFor = () =>
    factors.goesTo(midfield, "run", ["Busy", "Spare"]).get("Busy") ?? 0;
  const played: { first: number; second: number }[] = [];

  for (let game = 0; game < games; game++) {
    factors.startsGame?.(seededRng(game * 811 + 7));
    played.push({ first: askFor(), second: askFor() });
  }

  return played;
};

describe("the cut a game hands a man", () => {
  it("is the same on the first snap and the last", async () => {
    for (const game of await busyOverGames("0.6", 12)) {
      expect(game.second).toBeCloseTo(game.first, 10);
    }
  });

  it("is a different cut in the next game", async () => {
    const played = await busyOverGames("0.6", 40);
    const cuts = played.map((g) => g.first);
    const middle = cuts.reduce((a, b) => a + b, 0) / cuts.length;
    const spread = Math.sqrt(
      cuts.reduce((a, b) => a + (b - middle) ** 2, 0) / cuts.length,
    );

    expect(new Set(cuts).size).toBe(cuts.length);
    // the projection prices the two of them the same, so an even split
    // is what the draws should average out to
    expect(middle).toBeGreaterThan(0.4);
    expect(middle).toBeLessThan(0.6);
    expect(spread).toBeGreaterThan(0.05);
  });

  it("stands still across games when both widths are off", async () => {
    for (const game of await busyOverGames("0", 6)) {
      expect(game.first).toBeCloseTo(0.5, 10);
      expect(game.second).toBeCloseTo(0.5, 10);
    }
  });
});
