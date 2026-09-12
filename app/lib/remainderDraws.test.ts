/**
 * Which live games go to the remainder engine.
 *
 * Before half time the clock scaling wins, so the split is the whole
 * decision and it is worth pinning down.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { gamesToPlay, pastHalfTime, simTablesFor } from "./remainderDraws.ts";
import type { LiveSituation } from "./matchups.ts";

const at = (secondsLeft: number): LiveSituation => ({
  home: "NE", away: "NYJ",
  points: { NE: 17, NYJ: 10 },
  secondsLeft,
  withBall: "NE", yardline: 40, down: 2, toGo: 6,
  timeouts: { NE: 3, NYJ: 2 },
  redZone: false,
  secondHalf: secondsLeft <= 1800,
  warningLeft: true,
});

describe("which games are played out", () => {
  it("leaves the first half to the clock scaling", () => {
    expect(pastHalfTime(at(2400))).toBe(false);
    expect(pastHalfTime(at(1801))).toBe(false);
  });

  it("takes over at half time", () => {
    expect(pastHalfTime(at(1800))).toBe(true);
    expect(pastHalfTime(at(600))).toBe(true);
  });

  it("has nothing to play for a game that is over", () => {
    expect(pastHalfTime(at(0))).toBe(false);
  });

  it("plays a game once however many teams point at it", () => {
    const one = at(900);
    const games = gamesToPlay(new Map([["NE", one], ["NYJ", one]]));

    expect(games).toHaveLength(1);
    expect(games[0]!.state.withBall).toBe("NE");
    expect(games[0]!.state.secondHalf).toBe(true);
  });

  it("seeds two games apart", () => {
    const here = at(900);
    const there = { ...at(900), home: "KC", away: "LV" };
    const games = gamesToPlay(new Map([["NE", here], ["KC", there]]));

    expect(games[0]!.seed).not.toBe(games[1]!.seed);
  });
});

describe("finding a season's tables", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("takes last season's when this season has none", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      asked.push(url);

      return Promise.resolve({
        ok: url.includes("2098"),
        json: () => Promise.resolve({ season: 2098 }),
      });
    });

    expect(await simTablesFor(2099)).toEqual({ season: 2098 });
    expect(asked).toEqual(["data/sim-2099.json", "data/sim-2098.json"]);
  });

  it("gives up rather than reaching back further", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve({ ok: false }));

    expect(await simTablesFor(2097)).toBe(null);
  });
});
