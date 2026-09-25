/**
 * Sleeper's scores feed read into the same game ESPN's scoreboard is.
 * The live fixture is Falcons at Packers in the fourth quarter on a
 * Thursday night, with Sunday's Chargers at Bills still to come, and the
 * finished one is Seahawks at Cardinals from the week before.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { espnGamesFrom, situationsFrom } from "./matchups.ts";
import {
  sleeperGameOf, sleeperGamesFrom, type SleeperScoreGame,
} from "./sleeperScores.ts";

const fixture = <T>(name: string) => JSON.parse(readFileSync(
  join(import.meta.dirname, "..", "fixtures", name), "utf8")) as T;

const live = fixture<SleeperScoreGame[]>("sleeperScoresLive.json");
const final = fixture<SleeperScoreGame[]>("sleeperScoresFinal.json");
const espnBoard = fixture<Parameters<typeof situationsFrom>[0]>(
  "espnScoreboardLive.json");

const onNow = live.find((game) => game.status === "in_game")!;
const toCome = live.find((game) => game.status === "pre_game")!;

describe("sleeperGameOf", () => {
  it("reads a game in the fourth quarter", () => {
    expect(sleeperGameOf(onNow)).toEqual({
      where: "in",
      home: "GB",
      away: "ATL",
      points: { GB: 14, ATL: 27 },
      kickoff: 1790295300000,
      period: 4,
      clock: 352,
      withBall: "ATL",
      yardline: 53,
      down: 2,
      toGo: 8,
      timeouts: { GB: 3, ATL: 3 },
      redZone: false,
    });
  });

  it("reads a game that is over, with its final score", () => {
    expect(sleeperGameOf(final[0]!)).toMatchObject({
      where: "post", home: "ARI", away: "SEA", points: { ARI: 7, SEA: 31 },
    });
  });

  it("reads a game still to come, with its kickoff", () => {
    expect(sleeperGameOf(toCome)).toMatchObject({
      where: "pre", home: "BUF", away: "LAC", kickoff: 1790528400000,
    });
  });

  it("puts the ball in the other side's half when that is whose half it is", () => {
    const deep = {
      ...onNow,
      metadata: {
        ...onNow.metadata,
        yard_line: 12, yard_line_territory: "GB",
        down: 1, down_and_distance: "1st & 10",
      },
    };

    expect(sleeperGameOf(deep)).toMatchObject({
      yardline: 12, down: 1, toGo: 10, redZone: true,
    });
  });

  it("reads first and goal as the distance to the goal line", () => {
    const goal = {
      ...onNow,
      metadata: {
        ...onNow.metadata,
        yard_line: 4, yard_line_territory: "GB",
        down: 1, down_and_distance: "1st & Goal",
      },
    };

    expect(sleeperGameOf(goal)).toMatchObject({ yardline: 4, toGo: 4 });
  });

  it("counts used timeouts off three", () => {
    const used = {
      ...onNow,
      metadata: { ...onNow.metadata, home_used_timeouts: 2, away_used_timeouts: 1 },
    };

    expect(sleeperGameOf(used)?.timeouts).toEqual({ GB: 1, ATL: 2 });
  });

  it("gives no ball between plays, when the feed names nobody", () => {
    const between = {
      ...onNow,
      metadata: { ...onNow.metadata, possession: "", down: "" },
    };
    const read = sleeperGameOf(between)!;

    expect(read.withBall).toBeUndefined();
    expect(read.yardline).toBeUndefined();
    expect(read.down).toBeUndefined();
  });

  it("counts overtime as the fifth period", () => {
    const extra = {
      ...onNow,
      metadata: { ...onNow.metadata, quarter_num: 4, is_overtime: true },
    };

    expect(sleeperGameOf(extra)?.period).toBe(5);
  });

  it("leaves out a game on with no clock, for ESPN to fill", () => {
    const clockless = {
      ...onNow, metadata: { ...onNow.metadata, time_remaining: null },
    };

    expect(sleeperGameOf(clockless)).toBeNull();
  });

  it("leaves out a game with a status it does not know", () => {
    expect(sleeperGameOf({ ...onNow, status: "delayed" })).toBeNull();
  });

  it("leaves out a game that does not say who is playing", () => {
    expect(sleeperGameOf({ status: "in_game", metadata: {} })).toBeNull();
  });
});

describe("sleeperGamesFrom", () => {
  it("reads every game it can and drops the rest", () => {
    const got = sleeperGamesFrom([...live, { status: "in_game" }]);

    expect(got.map((game) => game.home)).toEqual(
      live.map((game) => game.metadata!.home_team));
  });

  it("reads anything other than a list as no games", () => {
    expect(sleeperGamesFrom({ error: "nope" })).toEqual([]);
  });
});

describe("the two scoreboards", () => {
  it("agree on the ball and the score at the same moment", () => {
    const fromEspn = espnGamesFrom(espnBoard).find((game) => game.home === "GB")!;
    const fromSleeper = sleeperGameOf(onNow)!;

    for (const field of ["home", "away", "points", "withBall", "yardline",
      "down", "toGo", "period"] as const) {
      expect(fromSleeper[field], field).toEqual(fromEspn[field]);
    }

    // and Sleeper's clock ran 35 seconds behind ESPN's
    expect(fromSleeper.clock - fromEspn.clock).toBe(35);
  });
});
