/**
 * A week one game, from an ESPN payload to each man's remaining points.
 *
 * The rest of the engine is checked against the Node simulator. What
 * this covers is the path the live page actually walks: a scoreboard
 * reply, the situation read off it, the game picked out as one past
 * half time, and the two men everybody knows getting sensible numbers.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { situationsFrom } from "./matchups.ts";
import { gamesToPlay, remainderDraws } from "./remainderDraws.ts";
import type { SimTables } from "./simTables.ts";

const PATH = "docs/data/sim-2026.json";
const PPR = {
  pass_yd: 0.04, pass_td: 4, pass_int: -2, rush_yd: 0.1, rush_td: 6,
  rec: 1, rec_yd: 0.1, rec_td: 6, fum_lost: -2, rush_2pt: 2,
};

/** Cincinnati at Cleveland, third quarter, the visitors driving */
const SCOREBOARD = {
  events: [{
    status: { period: 3, clock: 540, type: { state: "in" } },
    competitions: [{
      status: { period: 3, clock: 540, type: { state: "in" } },
      situation: {
        down: 2, distance: 7, yardLine: 62, possession: "4",
        homeTimeouts: 3, awayTimeouts: 2, isRedZone: false,
      },
      competitors: [
        { homeAway: "home", score: "13", team: { id: "5", abbreviation: "CLE" } },
        { homeAway: "away", score: "17", team: { id: "4", abbreviation: "CIN" } },
      ],
    }],
  }],
};

describe.skipIf(!existsSync(PATH))("a week one game, end to end", () => {
  const tables = JSON.parse(readFileSync(PATH, "utf8")) as SimTables;
  const situations = situationsFrom(SCOREBOARD);

  it("reads the situation off the scoreboard", () => {
    const game = situations.get("CIN")!;

    expect(game.home).toBe("CLE");
    expect(game.away).toBe("CIN");
    expect(game.withBall).toBe("CIN");
    // ESPN counts from the offence's own goal, the engine from the other
    expect(game.yardline).toBe(38);
    expect(game.secondsLeft).toBe(1440);
    expect(game.secondHalf).toBe(true);
    expect(game.points["CIN"]).toBe(17);
  });

  it("plays it out rather than leaving it to the copula", () => {
    expect(gamesToPlay(situations)).toHaveLength(1);
  });

  it("gives the two men everybody knows a sensible afternoon", () => {
    const played = remainderDraws(tables, situations, PPR, 400);
    const burrow = played.get("joeburrow");
    const chase = played.get("jamarrchase");

    expect(burrow).toBeDefined();
    expect(chase).toBeDefined();

    const mean = (its: number[]) =>
      its.reduce((sum, one) => sum + one, 0) / its.length;

    console.log(`Burrow ${mean(burrow!).toFixed(2)}, ` +
      `Chase ${mean(chase!).toFixed(2)} over a quarter and a half`);

    expect(mean(burrow!)).toBeGreaterThan(2);
    expect(mean(burrow!)).toBeLessThan(18);
    expect(mean(chase!)).toBeGreaterThan(1);
    expect(mean(chase!)).toBeLessThan(14);
  });

  it("leaves a man the tables have never heard of to the copula", () => {
    const played = remainderDraws(tables, situations, PPR, 50);

    expect(played.has("nobodyatall")).toBe(false);
  });
});
