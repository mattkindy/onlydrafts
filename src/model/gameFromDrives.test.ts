import { describe, expect, it, vi } from "vitest";
import type { EndingRules } from "./driveFromFactors.js";
import { onTheDay } from "./driveFromFactors.js";
import type { PlayClock } from "../features/fitPlayClock.js";
import type { FourthDown } from "../features/fitFourthDown.js";
import type { PlayFactors } from "./playFactors.js";
import type { Side } from "./gameFromDrives.js";
import { seededRng } from "../sim/rng.js";

/**
 * The width is read out of the environment when the module loads, so
 * a test that wants a different one has to reload the module.
 */
const withWidth = async (width: string) => {
  vi.resetModules();
  process.env["SIDE_DAY"] = width;
  const loaded = await import("./gameFromDrives.js");
  delete process.env["SIDE_DAY"];

  return loaded;
};

/** every man carries for the same ten yards, so the day is all that moves */
const GAINS = 10;

const factors: PlayFactors = {
  runs: () => 1,
  goesTo: (_state, _call, among) =>
    new Map(among.map((who) => [who, 1 / among.length])),
  gains: () => GAINS,
  scores: () => 0,
  caught: () => true,
};

const sideOf = (team: string, men: string[]): Side =>
  ({ team, among: men, factors });

const rules: EndingRules = {
  kickSucceeds: () => 1,
  puntLands: () => 50,
  turnoverRate: () => 0,
  penaltyFirstDown: 0,
  penaltyYards: () => 10,
  maxPlays: 40,
};

/** always go for it, so no drive ends anywhere but the end zone */
const fourth: FourthDown = {
  chances: () => ({ go: 1, kick: 0, punt: 0 }),
  choose: () => "go",
};

const ticking: PlayClock = {
  secondsFor: () => 30, paceOf: () => 1, learnedOn: 0,
};

/**
 * The gains each side made, by the man who made them, off one played
 * game. Plays that ran out of field are dropped, since the yardline
 * caps those before the day is ever visible in them.
 */
async function gainsBySide(width: string, seed: number) {
  const { playGame } = await withWidth(width);
  const home = sideOf("HOME", ["Abe", "Bob", "Cal"]);
  const away = sideOf("AWAY", ["Dan", "Eli", "Fay"]);
  const game = playGame(home, away, { rules, fourth, clock: {
    isLast: 0, lastLength: () => 12,
  }, ticking }, seededRng(seed));
  const byTeam = new Map<string, Map<string, number[]>>();

  for (const one of game.possessions) {
    const byMan = byTeam.get(one.team) ?? new Map<string, number[]>();
    byTeam.set(one.team, byMan);

    for (const play of one.drive.plays) {
      if (play.scored) {
        continue;
      }

      byMan.set(play.player, [...(byMan.get(play.player) ?? []), play.yards]);
    }
  }

  return byTeam;
}

/**
 * The two whole yards a side's ten yard carries can land on. A day of
 * d turns ten yards into floor(10d) or one more, so every man on the
 * side shares one pair and the pair says what the day was.
 */
const landedOn = (byMan: Map<string, number[]>) =>
  [...new Set([...byMan.values()].flat())].sort((a, b) => a - b);

describe("the day a game hands a side", () => {
  it("is the same for every man on that side", async () => {
    const byTeam = await gainsBySide("0.3", 41);

    for (const byMan of byTeam.values()) {
      const shared = landedOn(byMan);
      expect(shared.length).toBeLessThanOrEqual(2);

      for (const his of byMan.values()) {
        expect(his.every((y) => shared.includes(y))).toBe(true);
      }
    }
  });

  it("is its own on each side of the game", async () => {
    const byTeam = await gainsBySide("0.3", 41);
    const home = landedOn(byTeam.get("HOME") ?? new Map());
    const away = landedOn(byTeam.get("AWAY") ?? new Map());

    expect(home.length).toBeGreaterThan(0);
    expect(away.length).toBeGreaterThan(0);
    expect(home[0]).not.toBe(away[0]);
  });

  it("is a different day in the next game", async () => {
    const days = new Set<number>();

    for (const seed of [41, 97, 233, 617]) {
      const byTeam = await gainsBySide("0.3", seed);
      days.add(landedOn(byTeam.get("HOME") ?? new Map())[0] ?? 0);
    }

    expect(days.size).toBeGreaterThan(1);
  });

  it("leaves every gain where it was when the width is off", async () => {
    const byTeam = await gainsBySide("0", 41);

    for (const byMan of byTeam.values()) {
      expect(landedOn(byMan)).toEqual([GAINS]);
    }
  });
});

describe("a side's day on one gain", () => {
  it("scales a gain that comes out whole", () => {
    expect(onTheDay(10, 1.5, () => 0.5)).toBe(15);
  });

  it("turns the leftover fraction into a chance of one more yard", () => {
    const draw = seededRng(11);
    const gains: number[] = [];

    for (let i = 0; i < 4000; i++) {
      gains.push(onTheDay(10, 1.05, draw));
    }

    expect(new Set(gains)).toEqual(new Set([10, 11]));
    expect(gains.reduce((a, b) => a + b, 0) / gains.length).toBeCloseTo(10.5, 1);
  });

  it("leaves a play that went nowhere or backwards alone", () => {
    expect(onTheDay(0, 1.5, () => 0.5)).toBe(0);
    expect(onTheDay(-4, 1.5, () => 0.5)).toBe(-4);
  });

  it("takes no draw when there is no day", () => {
    const taken = () => {
      throw new Error("drew when it had nothing to draw for");
    };

    expect(onTheDay(10, undefined, taken)).toBe(10);
    expect(onTheDay(10, 1, taken)).toBe(10);
  });
});

describe("the width of a side's day", () => {
  it("is one exactly, and takes no draw, when it is off", async () => {
    const { sideDay } = await withWidth("0");
    const taken = () => {
      throw new Error("drew when it had nothing to draw for");
    };

    expect(sideDay(taken)).toBe(1);
  });

  it("centres on one and spreads by what it was set to", async () => {
    const { sideDay } = await withWidth("0.2");
    const draw = seededRng(5);
    const days: number[] = [];

    for (let i = 0; i < 8000; i++) {
      days.push(sideDay(draw));
    }

    const mean = days.reduce((a, b) => a + b, 0) / days.length;
    const spread = Math.sqrt(
      days.reduce((a, b) => a + (b - mean) ** 2, 0) / days.length,
    );

    expect(mean).toBeCloseTo(1, 1);
    expect(spread).toBeGreaterThan(0.17);
    expect(spread).toBeLessThan(0.24);
  });
});
