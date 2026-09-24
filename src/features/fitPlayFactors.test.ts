import { describe, expect, it, vi } from "vitest";
import type { CountedPlays, GoalSample, PlayRow } from "./fitPlayFactors.js";
import {
  keysAt, marginBand, nearnessWeight, stateKey, timeBand, wideningPacked,
  type Call, type PlayState,
} from "../model/playFactors.js";
import { seededRng } from "../sim/rng.js";
import { bandOf } from "./targetDepth.js";

/**
 * The carry is read out of the environment when the module loads, so
 * both settings need their own load of it.
 */
const settleWith = async (lift: boolean) => {
  vi.resetModules();

  if (lift) {
    delete process.env["NO_GOAL_LIFT"];
  } else {
    process.env["NO_GOAL_LIFT"] = "1";
  }

  const loaded = await import("./fitPlayFactors.js");
  delete process.env["NO_GOAL_LIFT"];

  return loaded.settleAtGoal;
};

/** whatever the environment says, which is the carry on */
const settleAsShipped = async () => {
  vi.resetModules();
  const loaded = await import("./fitPlayFactors.js");

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

  it("carries a short throw up with nothing set in the environment", async () => {
    const settle = await settleAsShipped();

    expect(settle(atTheFive, "pass", 2, always(0.49), crossesTooRarely)).toBe(5);
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

describe("the pools of what a throw gains", () => {
  it("leaves out the sacks and the balls thrown away", async () => {
    const countPlays = await countWith(false);
    const counted = countPlays([aThrow("Diggs", 12), aThrow("", -7)]);

    expect(depthPool(counted).every((yards) => yards === 12)).toBe(true);
    expect([...counted.cells.values()].some((cell) => cell.yards.includes(-7)))
      .toBe(false);
  });

  it("counts a sack as a pass play all the same", async () => {
    const countPlays = await countWith(false);
    const counted = countPlays([aThrow("Diggs", 12), aThrow("", -7)]);
    const here = [...counted.cells.values()]
      .find((cell) => cell.yards.length === 1);

    expect(here?.plays).toBe(2);
  });

  it("keeps them with the flag set", async () => {
    const countPlays = await countWith(true);
    const counted = countPlays([aThrow("Diggs", 12), aThrow("", -7)]);

    expect(depthPool(counted)).toContain(-7);
    expect([...counted.cells.values()].some((cell) => cell.yards.includes(-7)))
      .toBe(true);
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

describe("a player's own draw near the goal", () => {
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

describe("a player's own draw out in the field", () => {
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
  it("splits two players the projection prices the same evenly", async () => {
    const shares = await carriesAtMidfield(undefined);

    expect(shares.get("Busy")).toBeCloseTo(0.5, 2);
    expect(shares.get("Spare")).toBeCloseTo(0.5, 2);
  });

  it("hands the busier player the difference with FROM_CALLS all the way up",
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

describe("the cut a game hands a player", () => {
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

/**
 * A league where tight ends take 40% of the throws from the three and
 * 20% of them at midfield, and receivers the rest. Two fresh players are
 * then asked about, neither of whom has ever caught anything, so the
 * only thing that can separate them is what their positions do here.
 */
const throwAt = (yardline: number, player: string): PlayRow => ({
  offence: "NE", defence: "NYJ", down: 1, toGo: yardline <= 10 ? 3 : 10,
  yardline, margin: 0, secondsLeft: 1800, call: "pass", yards: 6,
  touchdown: 0, player,
});

const freshPlayersAt = async (yardline: number, leansToPosition: boolean) => {
  vi.resetModules();

  if (leansToPosition) {
    delete process.env["NO_POSITION_LEAN"];
  } else {
    process.env["NO_POSITION_LEAN"] = "1";
  }

  const loaded = await import("./fitPlayFactors.js");
  delete process.env["NO_POSITION_LEAN"];

  const rows: PlayRow[] = [];

  for (let i = 0; i < 100; i++) {
    rows.push(throwAt(3, i % 5 < 2 ? "LeagueTE" : "LeagueWR"));
    rows.push(throwAt(60, i % 5 < 1 ? "LeagueTE" : "LeagueWR"));
  }

  const factors = loaded.fitPlayFactors(rows, loaded.FACTOR_DEFAULTS, {
    // August prices the two fresh players the same
    split: new Map([
      ["FreshTE", { carries: 0, targets: 0.2 }],
      ["FreshWR", { carries: 0, targets: 0.2 }],
    ]),
    positions: new Map([
      ["LeagueTE", "TE"], ["LeagueWR", "WR"],
      ["FreshTE", "TE"], ["FreshWR", "WR"],
    ]),
  });
  const state: PlayState = {
    down: 1, toGo: yardline <= 10 ? 3 : 10, yardline,
    margin: 0, secondsLeft: 1800,
  };

  return factors.goesTo(state, "pass", ["FreshTE", "FreshWR"]);
};

describe("a player with no plays of his own leans the way his position does", () => {
  it("hands the fresh tight end more of the throws from the three",
    async () => {
      const shares = await freshPlayersAt(3, true);

      expect(shares.get("FreshTE")!).toBeGreaterThan(0.55);
      expect(shares.get("FreshWR")!).toBeLessThan(0.45);
    });

  it("hands him fewer of them at midfield, where his position is thinner",
    async () => {
      const atGoal = await freshPlayersAt(3, true);
      const atMidfield = await freshPlayersAt(60, true);

      expect(atMidfield.get("FreshTE")!)
        .toBeLessThan(atGoal.get("FreshTE")!);
      expect(atMidfield.get("FreshTE")!).toBeLessThan(0.5);
    });

  it("splits them evenly at both spots when the leaning is turned off",
    async () => {
      for (const yardline of [3, 60]) {
        const shares = await freshPlayersAt(yardline, false);

        expect(shares.get("FreshTE")).toBeCloseTo(0.5, 6);
        expect(shares.get("FreshWR")).toBeCloseTo(0.5, 6);
      }
    });
});

/**
 * A league where the plays from the three all belong to two other players,
 * so the tight cell says nothing about either of the pair being asked
 * about. Both are backs, both are priced the same in August and both
 * carried it the same number of times, so their positions and their
 * season shares cannot separate them either. One took his carries in
 * the red zone and the other took his at midfield.
 */
const carryAt = (yardline: number, player: string): PlayRow => ({
  offence: "NE", defence: "NYJ", down: 1, toGo: 10,
  yardline, margin: 0, secondsLeft: 1800, call: "run", yards: 4,
  touchdown: 0, player,
});

const redZoneBackAt = async (wideLean: string) => {
  vi.resetModules();
  process.env["WIDE_LEAN"] = wideLean;
  const loaded = await import("./fitPlayFactors.js");
  delete process.env["WIDE_LEAN"];

  const rows: PlayRow[] = [];

  for (let i = 0; i < 60; i++) {
    rows.push(carryAt(3, i % 2 ? "GoalBack" : "GoalOther"));
    rows.push(carryAt(15, "RedZone"));
    rows.push(carryAt(55, "Midfield"));
  }

  const factors = loaded.fitPlayFactors(rows, loaded.FACTOR_DEFAULTS, {
    split: new Map([
      ["RedZone", { carries: 0.2, targets: 0 }],
      ["Midfield", { carries: 0.2, targets: 0 }],
    ]),
    positions: new Map([
      ["GoalBack", "RB"], ["GoalOther", "RB"],
      ["RedZone", "RB"], ["Midfield", "RB"],
    ]),
  });

  return factors.goesTo(
    { down: 1, toGo: 10, yardline: 3, margin: 0, secondsLeft: 1800 },
    "run", ["RedZone", "Midfield"],
  );
};

describe("a thin cell rests on a player's own leaning at a wider one", () => {
  it("splits the carries from the three evenly with the step off",
    async () => {
      const shares = await redZoneBackAt("0");

      expect(shares.get("RedZone")).toBeCloseTo(0.5, 6);
      expect(shares.get("Midfield")).toBeCloseTo(0.5, 6);
    });

  it("tells them apart with the step on, on where each one carried it",
    async () => {
      // a pool of a hundred, which the plays from the three and the
      // fifteen fill between them before it reaches midfield
      const shares = await redZoneBackAt("50");

      // the player who carried it near the three, not the one at midfield
      expect(shares.get("RedZone")! - shares.get("Midfield")!)
        .toBeGreaterThan(0.1);
    });
});

/**
 * A small league of random plays, with gains that are not whole yards so
 * that adding them in a different order would show in the last digit.
 */
const scatteredRows = (): PlayRow[] => {
  const uniform = seededRng(17);
  const pick = <T>(from: T[]) => from[Math.floor(uniform() * from.length)]!;
  const rows: PlayRow[] = [];

  for (let i = 0; i < 4000; i++) {
    const offence = pick(["NE", "NYJ", "MIA"]);
    rows.push({
      offence, defence: offence === "NE" ? "MIA" : "NE",
      down: 1 + Math.floor(uniform() * 4),
      toGo: 1 + Math.floor(uniform() * 15),
      yardline: 1 + Math.floor(uniform() * 99),
      margin: Math.floor(uniform() * 41) - 20,
      secondsLeft: Math.floor(uniform() * 3600),
      call: uniform() < 0.45 ? "run" : "pass",
      yards: Math.round((uniform() * 30 - 5) * 100) / 100,
      touchdown: uniform() < 0.05 ? 1 : 0,
      player: pick(["", "Back", "Wideout", "Slot", "End"]),
    });
  }

  return rows;
};

const scatteredStates = (): PlayState[] => {
  const uniform = seededRng(29);

  return [
    ...Array.from({ length: 14 }, () => ({
      down: 1 + Math.floor(uniform() * 4),
      toGo: 1 + Math.floor(uniform() * 15),
      yardline: 1 + Math.floor(uniform() * 99),
      margin: Math.floor(uniform() * 41) - 20,
      secondsLeft: Math.floor(uniform() * 3600),
    })),
    // and the edges, where the widening runs off the field or the table
    { down: 4, toGo: 45, yardline: 99, margin: -30, secondsLeft: 10 },
    { down: 1, toGo: 1, yardline: 1, margin: 30, secondsLeft: 3600 },
  ];
};

const LEASTS = [0, 7, 60, 250, 1000, 100000];

/** each spot of the widening in order, with the looseness it was let go by */
const spotsInOrder = (state: PlayState) =>
  [0, 1, 2].flatMap((looseness) =>
    [...wideningPacked(state.toGo, state.yardline)]
      .filter((packed) => Math.floor(packed / 100000) === looseness)
      .map((packed) => ({
        looseness,
        keys: keysAt(
          state.down, Math.floor(packed / 100) % 1000, packed % 100,
          state.secondsLeft, state.margin, looseness,
        ),
      })));

type Cell = CountedPlays["cells"] extends Map<string, infer C> ? C : never;

describe("a side's pool read through its own cells", () => {
  /** the walk as it was written against the whole side table */
  const sideAsWalked = (
    counted: CountedPlays, from: Map<string, Cell>, who: string,
    spots: ReturnType<typeof spotsInOrder>, least: number, call?: Call,
  ) => {
    let found = { plays: 0, runs: 0, yardsSum: 0, leaguePlays: 0, leagueRuns: 0 };

    for (const looseness of [0, 1, 2]) {
      const pooled = { plays: 0, runs: 0, yardsSum: 0, leaguePlays: 0, leagueRuns: 0 };

      for (const spot of spots) {
        if (spot.looseness !== looseness) {
          continue;
        }

        for (const cellKey of spot.keys) {
          const cell = from.get(`${who}|${call ? `${call}|${cellKey}` : cellKey}`);

          if (!cell) {
            continue;
          }

          pooled.plays += cell.plays;
          pooled.runs += cell.runs;
          pooled.yardsSum += cell.yards.reduce((a, b) => a + b, 0);
          const everybody = counted.cells.get(call ? `${call}|${cellKey}` : cellKey);

          if (everybody) {
            pooled.leaguePlays += everybody.plays;
            pooled.leagueRuns += everybody.runs;
          }
        }

        if (pooled.plays >= least) {
          break;
        }
      }

      found = pooled;

      if (found.plays >= least) {
        break;
      }
    }

    return found;
  };

  it("sums the same cells in the same order as the keyed walk", async () => {
    vi.resetModules();
    const loaded = await import("./fitPlayFactors.js");
    const counted = loaded.countPlays(scatteredRows());
    const yardsOf = (cell: Cell) => cell.yards.reduce((a, b) => a + b, 0);
    let filled = 0;

    for (const from of [counted.byOffence, counted.byDefence]) {
      const split = loaded.splitBySide(from);

      for (const state of scatteredStates()) {
        const spots = spotsInOrder(state);

        for (const who of ["NE", "NYJ", "BUF"]) {
          for (const call of ["run", "pass", undefined] as const) {
            const league = call
              ? loaded.cellsUnder(counted.cells, call)
              : counted.cells;

            for (const least of LEASTS) {
              const found = loaded.poolForSide(
                state, least, split.get(who)?.get(call ?? "both"),
                league, yardsOf,
              );
              expect(found)
                .toEqual(sideAsWalked(counted, from, who, spots, least, call));
              filled += found.plays > 0 ? 1 : 0;
            }
          }
        }
      }
    }

    // most of the pools found plays, so the order was put to the test
    expect(filled).toBeGreaterThan(500);
  });
});

describe("the share pool cut from one walk for any number of plays", () => {
  /** the cells as they were gathered afresh for each number of plays */
  const cellsAsWalked = (
    counted: CountedPlays, spots: ReturnType<typeof spotsInOrder>,
    least: number, call?: Call,
  ) => {
    let found: Cell[] = [];
    let plays = 0;

    for (const looseness of [0, 1, 2]) {
      if (plays >= least) {
        break;
      }

      const pooled: Cell[] = [];
      plays = 0;

      for (const spot of spots) {
        if (spot.looseness !== looseness) {
          continue;
        }

        for (const cellKey of spot.keys) {
          const cell = counted.cells.get(call ? `${call}|${cellKey}` : cellKey);

          if (!cell) {
            continue;
          }

          pooled.push(cell);
          plays += cell.plays;
        }

        if (plays >= least) {
          break;
        }
      }

      found = pooled;
    }

    return found;
  };

  const sameCells = (a: Cell[], b: Cell[]) =>
    a.length === b.length && a.every((cell, i) => cell === b[i]);

  it("gathers the same cells whatever order the numbers are asked in",
    async () => {
      vi.resetModules();
      const loaded = await import("./fitPlayFactors.js");
      const counted = loaded.countPlays(scatteredRows());
      const asked = [60, 7, 100000, 0, 1000, 250, 61, 59.5, 3000];
      let widened = 0;

      for (const state of scatteredStates()) {
        const spots = spotsInOrder(state);

        for (const call of ["run", "pass", undefined] as const) {
          const walk = loaded.widenedCells(state, loaded.rowsOf(
            call ? loaded.cellsUnder(counted.cells, call) : counted.cells,
          ));

          for (const least of asked) {
            const found = walk.upTo(least);
            const expected = cellsAsWalked(counted, spots, least, call);
            expect(sameCells(found, expected)).toBe(true);
            // and the same array back for the same cut, so sums kept
            // against it are found again
            expect(walk.upTo(least)).toBe(found);
            widened += found.length > 1 ? 1 : 0;
          }
        }
      }

      expect(widened).toBeGreaterThan(100);
    });
});

describe("a widening walked over two formations at once", () => {
  it("reaches the cells in the order the keyed walk reached them",
    async () => {
      vi.resetModules();
      const loaded = await import("./fitPlayFactors.js");
      const rows = scatteredRows().map((row, i) => ({ ...row, shotgun: i % 3 > 0 }));
      const counted = loaded.countPlays(rows);
      const forms = ["gun", "centre"];
      const inForm = forms.map((form) =>
        loaded.rowsOf(loaded.cellsUnder(counted.cells, form)));
      let reached = 0;

      for (const state of scatteredStates()) {
        const spots = spotsInOrder(state);

        for (const looseness of [0, 1, 2]) {
          for (const least of LEASTS) {
            const expected: [string, Cell][] = [];
            let plays = 0;

            for (const spot of spots) {
              if (spot.looseness !== looseness) {
                continue;
              }

              for (const cellKey of spot.keys) {
                for (const form of forms) {
                  const cell = counted.cells.get(`${form}|${cellKey}`);

                  if (cell) {
                    expected.push([form, cell]);
                    plays += cell.plays;
                  }
                }
              }

              if (plays >= least) {
                break;
              }
            }

            const found: [string, Cell][] = [];
            let walked = 0;
            loaded.walkWidening(inForm, state, looseness, ({ cell }, set) => {
              found.push([forms[set]!, cell]);
              walked += cell.plays;
            }, () => walked >= least);

            expect(found.length).toBe(expected.length);
            expect(found.every(([form, cell], i) =>
              form === expected[i]![0] && cell === expected[i]![1])).toBe(true);
            reached += found.length;
          }
        }
      }

      expect(reached).toBeGreaterThan(1000);
    });
});

describe("the cells under a call or a formation", () => {
  it("finds what the prefixed key finds, and nothing else", async () => {
    vi.resetModules();
    const loaded = await import("./fitPlayFactors.js");
    const rows = scatteredRows().map((row, i) => ({ ...row, shotgun: i % 3 > 0 }));
    const counted = loaded.countPlays(rows);

    for (const prefix of ["run", "pass", "gun", "centre", "gun|run"]) {
      const under = loaded.cellsUnder(counted.cells, prefix);

      for (const [key, cell] of under) {
        expect(counted.cells.get(`${prefix}|${key}`)).toBe(cell);
      }

      const expected = [...counted.cells.keys()]
        .filter((key) => key.startsWith(`${prefix}|`)).length;
      expect(under.size).toBe(expected);
    }
  });
});

describe("the touches of the players on the field over a pool", () => {
  it("comes to what adding each of them up cell by cell comes to",
    async () => {
      vi.resetModules();
      const loaded = await import("./fitPlayFactors.js");
      const counted = loaded.countPlays(scatteredRows());
      const passes = loaded.rowsOf(loaded.cellsUnder(counted.cells, "pass"));
      // a short cast, one longer than any cell, and players nobody counted
      const casts = [
        ["Back", "Nobody"],
        ["Back", "Wideout", "Slot", "End", "Nobody", "Else", "Other"],
        // and a player named twice, who is the same player both times
        ["Wideout", "Back", "Wideout"],
      ];
      const numbered = loaded.playerIndex();

      for (const state of scatteredStates()) {
        const pool = loaded.widenedCells(state, passes).upTo(250);

        for (const among of casts) {
          const took = numbered.touchesAmong(pool, among);

          among.forEach((player, place) => {
            let touches = 0;

            for (const cell of pool) {
              touches += cell.byPlayer.get(player)?.touches ?? 0;
            }

            expect(took[place]).toBe(touches);
          });
        }
      }
    });

  it("comes to what adding each position up cell by cell comes to",
    async () => {
      vi.resetModules();
      const loaded = await import("./fitPlayFactors.js");
      const counted = loaded.countPlays(scatteredRows());
      const passes = loaded.rowsOf(loaded.cellsUnder(counted.cells, "pass"));
      const positions = new Map([
        ["Back", "RB"], ["Wideout", "WR"], ["Slot", "WR"], ["End", "TE"],
      ]);
      const numbered = loaded.playerIndex(positions);
      let all = 0;

      for (const state of scatteredStates()) {
        const pool = loaded.widenedCells(state, passes).upTo(250);
        // each cell's positions first, then those over the pool, the way
        // the maps added them up
        const byCell = pool.map((cell) => {
          const sums = new Map<string, number>();

          for (const [player, own] of cell.byPlayer) {
            const position = positions.get(player);

            if (position) {
              sums.set(position, (sums.get(position) ?? 0) + own.touches);
            }
          }

          return sums;
        });

        for (const position of ["WR", "RB", "TE", "QB"]) {
          let touches = 0;

          for (const sums of byCell) {
            touches += sums.get(position) ?? 0;
          }

          expect(numbered.positionTouchesOver(pool, position)).toBe(touches);
        }

        for (const cell of pool) {
          let here = 0;

          for (const own of cell.byPlayer.values()) {
            here += own.touches;
          }

          expect(numbered.castOf(cell).total).toBe(here);
          all += here;
        }
      }

      expect(all).toBeGreaterThan(1000);
    });
});

describe("a player's touches over a pool, added up once", () => {
  it("comes to what adding him up cell by cell comes to", async () => {
    vi.resetModules();
    const loaded = await import("./fitPlayFactors.js");
    const counted = loaded.countPlays(scatteredRows());
    let asked = 0;
    const hisTouches = loaded.summedOverCells((cell, player) => {
      asked++;
      return cell.byPlayer.get(player)?.touches ?? 0;
    });

    const passes = loaded.rowsOf(loaded.cellsUnder(counted.cells, "pass"));

    for (const state of scatteredStates()) {
      const pool = loaded.widenedCells(state, passes).upTo(250);

      for (const player of ["Back", "Wideout", "Nobody"]) {
        let touches = 0;

        for (const cell of pool) {
          touches += cell.byPlayer.get(player)?.touches ?? 0;
        }

        expect(hisTouches(pool, player)).toBe(touches);
      }
    }

    // and a second time without going back over the cells
    const before = asked;
    const pool = loaded.widenedCells(scatteredStates()[0]!, passes).upTo(250);
    hisTouches(pool, "Back");
    const once = asked;
    hisTouches(pool, "Back");
    expect(asked).toBe(once);
    expect(once).toBeGreaterThan(before);
  });
});

describe("a pool's gains read where they sit in its cells", () => {
  /** the same league with a depth on each throw to a player */
  const thrownRows = () => scatteredRows().map((row, i) =>
    row.call === "pass" && row.player ? { ...row, airYards: (i % 45) - 5 } : row);

  /** the pool as the gather used to build it, every cell copied into one */
  const merged = (cells: Cell[]) => {
    const one = {
      yards: [] as number[], from: [] as number[],
      byDepth: new Map<number, number[]>(),
      byDepthFrom: new Map<number, number[]>(),
      byPlayer: new Map<string, {
        touches: number; yards: number; scores: number;
        long: number; longYards: number;
      }>(),
    };

    for (const cell of cells) {
      one.yards.push(...cell.yards);
      one.from.push(...cell.from);

      for (const [band, gains] of cell.byDepth) {
        one.byDepth.set(band, [...(one.byDepth.get(band) ?? []), ...gains]);
        one.byDepthFrom.set(band, [
          ...(one.byDepthFrom.get(band) ?? []),
          ...(cell.byDepthFrom.get(band) ?? []),
        ]);
      }

      for (const [player, own] of cell.byPlayer) {
        const already = one.byPlayer.get(player) ??
          { touches: 0, yards: 0, scores: 0, long: 0, longYards: 0 };
        already.touches += own.touches;
        already.yards += own.yards;
        already.scores += own.scores;
        already.long += own.long;
        already.longYards += own.longYards;
        one.byPlayer.set(player, already);
      }
    }

    return one;
  };

  type Split = { yards: number[]; weights: number[]; total: number };

  /** the copy split by end the way the draw used to split it */
  const splitAsCopied = (yards: number[], from: number[], yardline: number) => {
    const ends: Record<"nowhere" | "short" | "long", Split> = {
      nowhere: { yards: [], weights: [], total: 0 },
      short: { yards: [], weights: [], total: 0 },
      long: { yards: [], weights: [], total: 0 },
    };
    let weight = 0;
    let plain = 0;

    for (let i = 0; i < yards.length; i++) {
      const gained = yards[i]!;
      const near = nearnessWeight(Math.abs((from[i] ?? yardline) - yardline));
      weight += near;

      if (gained < 20) {
        plain += gained * near;
      }

      const into = gained <= 0 ? ends.nowhere
        : gained >= 20 ? ends.long
        : ends.short;
      into.yards.push(gained);
      into.weights.push(near);
      into.total += near;
    }

    return { ends, weight, plain };
  };

  const drawAsCopied = (split: Split, uniform: () => number) => {
    let left = uniform() * split.total;

    for (let i = 0; i < split.yards.length; i++) {
      left -= split.weights[i]!;

      if (left <= 0) {
        return split.yards[i]!;
      }
    }

    return split.yards[split.yards.length - 1]!;
  };

  it("weighs and draws each end the way the copy did", async () => {
    vi.resetModules();
    const loaded = await import("./fitPlayFactors.js");
    const counted = loaded.countPlays(scatteredRows());
    let drawn = 0;

    for (const call of ["run", "pass"] as const) {
      const rows = loaded.rowsOf(loaded.cellsUnder(counted.cells, call));

      for (const state of scatteredStates()) {
        const pool = loaded.widenedCells(state, rows).upTo(300);
        const whole = merged(pool);
        const y = state.yardline;

        for (const atLeast of [undefined, y]) {
          const kept = whole.yards.flatMap((_, i) =>
            atLeast === undefined || (whole.from[i] ?? 0) >= atLeast ? [i] : []);
          const copied = splitAsCopied(
            kept.map((i) => whole.yards[i]!), kept.map((i) => whole.from[i]!), y,
          );
          const from = { parts: pool, atLeast };
          const tallied = loaded.tallyEnds(from, y);

          expect(tallied.weight).toBe(copied.weight);
          expect(tallied.plain).toBe(copied.plain);

          for (const end of ["nowhere", "short", "long"] as const) {
            expect(tallied.ends[end].count).toBe(copied.ends[end].yards.length);
            expect(tallied.ends[end].total).toBe(copied.ends[end].total);

            if (!copied.ends[end].yards.length) {
              continue;
            }

            for (let seed = 1; seed <= 6; seed++) {
              expect(loaded.drawAt(
                from, end, tallied.ends[end].total, y, seededRng(seed),
              )).toBe(drawAsCopied(copied.ends[end], seededRng(seed)));
              drawn++;
            }
          }
        }

        expect(loaded.withRoom(pool, y))
          .toBe(whole.from.filter((spot) => spot >= y).length);
        expect(loaded.yardsOver(pool))
          .toBe(whole.yards.reduce((a, b) => a + b, 0));

        for (const player of ["Back", "Wideout", "Slot", "End", "Nobody"]) {
          expect(loaded.hisOver(pool, player)).toEqual(whole.byPlayer.get(player));
        }
      }
    }

    expect(drawn).toBeGreaterThan(200);
  });

  it("finds the same gains at a depth as the copy did", async () => {
    vi.resetModules();
    const loaded = await import("./fitPlayFactors.js");
    const counted = loaded.countPlays(thrownRows());
    const passes = loaded.rowsOf(loaded.cellsUnder(counted.cells, "pass"));
    const leaning = [0.5, 1, 1.5, 1, 2, 0.7];

    /** the depth lookup as it read the copied pool */
    const atDepthAsCopied = (
      whole: ReturnType<typeof merged>, band: number, room = 0,
    ): { yards: number[]; from: number[] } => {
      const found = { yards: [] as number[], from: [] as number[] };
      const take = (at: number) => {
        const gains = whole.byDepth.get(at) ?? [];
        const from = whole.byDepthFrom.get(at) ?? [];

        for (let i = 0; i < gains.length; i++) {
          if (room <= 0 || (from[i] ?? 0) >= room) {
            found.yards.push(gains[i]!);
            found.from.push(from[i] ?? 0);
          }
        }
      };

      take(band);

      for (let step = 1; step < 6 && found.yards.length < 40; step++) {
        take(band - step);
        take(band + step);
      }

      return room > 0 && found.yards.length < 20
        ? atDepthAsCopied(whole, band)
        : found;
    };

    const bandAsCopied = (
      whole: ReturnType<typeof merged>, uniform: () => number,
    ) => {
      const weights = leaning.map((lean, band) =>
        (whole.byDepth.get(band) ?? []).length * lean);
      const total = weights.reduce((a, b) => a + b, 0);

      if (total <= 0) {
        return 0;
      }

      let left = uniform() * total;

      for (let band = 0; band < weights.length; band++) {
        left -= weights[band]!;

        if (left <= 0) {
          return band;
        }
      }

      return weights.length - 1;
    };

    let found = 0;

    for (const state of scatteredStates()) {
      const pool = loaded.widenedCells(state, passes).upTo(300);
      const whole = merged(pool);

      for (let band = 0; band < leaning.length; band++) {
        for (const room of [0, state.yardline, 30]) {
          const atDepth = loaded.gainsAtDepth(pool, band, room);
          expect(atDepth).toEqual(atDepthAsCopied(whole, band, room));
          found += atDepth.yards.length;
        }
      }

      for (let seed = 1; seed <= 6; seed++) {
        expect(loaded.bandHere(pool, leaning, seededRng(seed)))
          .toBe(bandAsCopied(whole, seededRng(seed)));
      }
    }

    expect(found).toBeGreaterThan(1000);
  });
});

describe("the counts kept under a player and a call, split by the call", () => {
  const players = ["Back", "Wideout", "Slot", "End", "Nobody", ""];

  it("find what the joined key finds", async () => {
    vi.resetModules();
    const loaded = await import("./fitPlayFactors.js");
    const counted = loaded.countPlays(scatteredRows());
    const onCall = loaded.splitByCall(counted.onCall);
    const byPlayer = loaded.splitByCall(counted.byPlayer);

    for (const call of ["run", "pass"] as const) {
      for (const player of players) {
        expect(onCall[call].get(player))
          .toBe(counted.onCall.get(`${player}|${call}`));
        expect(byPlayer[call].get(player))
          .toBe(counted.byPlayer.get(`${player}|${call}`));
      }
    }
  });

  it("find each script bucket's counts where its key finds them",
    async () => {
      vi.resetModules();
      const loaded = await import("./fitPlayFactors.js");
      const counted = loaded.countPlays(scatteredRows());
      const tables = loaded.scriptTablesOf(counted.inScript, counted.scriptPlays);
      let found = 0;

      for (const state of scatteredStates()) {
        const how = state.margin <= -9 ? "chasing"
          : state.margin >= 9 ? "ahead"
          : "level";
        const bucket = `${how}|` +
          `${state.down >= 3 && state.toGo >= 4 ? "long" : "normal"}`;

        for (const call of ["run", "pass"] as const) {
          const table =
            tables[call][loaded.scriptAt(state.margin, state.down, state.toGo)]!;
          expect(table.plays)
            .toBe(counted.scriptPlays.get(`${bucket}|${call}`) ?? 0);

          for (const player of players) {
            const took = counted.inScript.get(`${bucket}|${call}|${player}`);
            expect(table.players.get(player)).toBe(took);
            found += took ? 1 : 0;
          }
        }
      }

      expect(found).toBeGreaterThan(50);
    });
});

/**
 * Whether two lists of keys fall together in the same places: each old key
 * always meets the same new one, and each new key the same old one.
 */
const sameMatches = (pairs: { old: string; key: number | string }[]) => {
  const forward = new Map<string, number | string>();
  const back = new Map<number | string, string>();

  return pairs.every(({ old, key }) => {
    const wasKey = forward.get(old) ?? key;
    const wasOld = back.get(key) ?? old;
    forward.set(old, key);
    back.set(key, old);

    return wasKey === key && wasOld === old;
  });
};

describe("the keys the memos are kept under", () => {
  const states = (): PlayState[] => [
    ...scatteredStates(),
    // two scores in the same band, which the key folds together
    { down: 2, toGo: 6, yardline: 40, margin: 1, secondsLeft: 1200 },
    { down: 2, toGo: 6, yardline: 40, margin: 3, secondsLeft: 1300 },
    // distances past the cap, which only the capped key folds together
    { down: 4, toGo: 41, yardline: 60, margin: -30, secondsLeft: 10 },
    { down: 4, toGo: 45, yardline: 60, margin: -30, secondsLeft: 10 },
    // and a spot that is not a whole yard, which only a string can keep
    { down: 2, toGo: 7, yardline: 33.5, margin: 3, secondsLeft: 1200 },
    { down: 5, toGo: 0, yardline: 0, margin: 0, secondsLeft: 0 },
  ];
  const leasts = [0, 7, 60.5, 300, 520, 70000];

  it("match where the string keys they replace matched", async () => {
    vi.resetModules();
    const loaded = await import("./fitPlayFactors.js");
    const pairs: { old: string; key: number | string }[] = [];

    for (const state of states()) {
      for (const call of ["run", "pass", undefined] as const) {
        for (const least of leasts) {
          pairs.push({
            old: `${call ?? "both"}|${stateKey(
              state.down, state.toGo, state.yardline, state.secondsLeft,
              state.margin,
            )}|${least}`,
            key: loaded.memoKey(loaded.callCode(call), state, least),
          });
        }
      }
    }

    expect(sameMatches(pairs)).toBe(true);
    // most of them packed into numbers, and a few fell back to strings
    expect(pairs.filter(({ key }) => typeof key === "number").length)
      .toBeGreaterThan(pairs.length / 2);
    expect(pairs.some(({ key }) => typeof key === "string")).toBe(true);
  });

  it("keep a walk's distance and yardline as they are, as its key did",
    async () => {
      vi.resetModules();
      const loaded = await import("./fitPlayFactors.js");
      const pairs = states().flatMap((state) =>
        (["run", "pass", undefined] as const).map((call) => ({
          old: `${call ?? "both"}|${Math.min(4, state.down)}|${state.toGo}` +
            `|${state.yardline}|${timeBand(state.secondsLeft)}` +
            `|${marginBand(state.margin)}`,
          key: loaded.walkKey(state, call),
        })));

      expect(sameMatches(pairs)).toBe(true);
      expect(new Set(pairs.map(({ key }) => key)).size)
        .toBe(new Set(pairs.map(({ old }) => old)).size);
    });
});

describe("the lists a count keeps as it goes", () => {
  it("keep every row's gain, depth and spot in the order the rows came",
    async () => {
      vi.resetModules();
      const loaded = await import("./fitPlayFactors.js");
      const rows = scatteredRows().map((row, i) =>
        row.call === "pass" && row.player
          ? { ...row, airYards: (i % 45) - 5, passer: `QB${i % 3}` }
          : row);
      const counted = loaded.countPlays(rows);
      const plays = loaded.storePlays(rows);
      let checked = 0;

      for (const [key, cell] of counted.cells) {
        const parts = key.split("|");

        if (parts[0] !== "pass" || parts[4] !== "any") {
          continue;
        }

        const [, down, toGo, yardline] = parts.map(Number);
        const here = rows.filter((row) =>
          row.call === "pass" && row.player && Math.min(4, row.down) === down &&
          Math.min(40, row.toGo) === toGo &&
          Math.min(99, row.yardline) === yardline);

        for (const [band, gains] of cell.byDepth) {
          const mine = here.filter((row) => bandOf(row.airYards!) === band);
          expect(gains).toEqual(mine.map((row) => row.yards));
          expect(cell.byDepthFrom.get(band))
            .toEqual(mine.map((row) => row.yardline));
          checked += gains.length;
        }
      }

      const kept = rows.filter((row) => row.player);

      for (const [key, list] of plays.ofPlayer) {
        expect(list).toEqual(kept.flatMap((row, i) =>
          `${row.player}|${row.call}` === key ? [i] : []));
      }

      for (const [key, list] of plays.ofPair) {
        expect(list).toEqual(kept.flatMap((row, i) =>
          row.call === "pass" && `${row.player}|${row.passer}` === key
            ? [i]
            : []));
      }

      expect(checked).toBeGreaterThan(1000);
    });
});
