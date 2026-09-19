/**
 * The board is built in the summer and a player goes on a list in
 * September, so the list has to be laid over the top of it.
 */

import { describe, expect, it } from "vitest";

import {
  gamesLeft, outThisWeek, playChance, pricedDown, WEEKS_OUT,
} from "./availability.ts";

describe("what a player on a list is expected to play", () => {
  it("takes six games off him", () => {
    expect(gamesLeft(16.4, "IR")).toBe(17 - WEEKS_OUT);
    expect(gamesLeft(12.2, "PUP")).toBe(17 - WEEKS_OUT);
  });

  it("leaves a player who is merely questionable alone", () => {
    expect(gamesLeft(14.1, "Questionable")).toBe(14.1);
    expect(gamesLeft(14.1, null)).toBe(14.1);
  });

  /**
   * A player the board has already marked further down knows something
   * the word on the list does not say, so the lower number wins.
   */
  it("keeps a harsher number when the board has one", () => {
    expect(gamesLeft(4, "IR")).toBe(4);
  });

  it("takes a player with nothing said about him as playing them all", () => {
    expect(gamesLeft(undefined, null)).toBe(17);
  });
});

/**
 * NA reads like not active and means no designation. The players carrying
 * it are Peyton Hillis, Derek Carr and Adam Thielen: retired, or an old
 * note nobody cleared. Taking it for a spell out docked six games from
 * anybody with a stale flag, Brock Purdy among them.
 */
describe("a word that looks like it means out", () => {
  it("leaves a player marked NA where the board had him", () => {
    expect(gamesLeft(9.1, "NA")).toBe(9.1);
  });

  /**
   * The other way round for one Sunday. A player on a roster in October
   * carrying NA is not active, whatever the stale flags on the draft
   * board mean.
   */
  it("counts NA as not playing this week", () => {
    expect(outThisWeek("NA")).toBe(true);
  });
});

describe("who does not play this week", () => {
  it("rules out the players the injury report has parked", () => {
    for (const word of ["Out", "IR", "PUP", "Sus", "DNR", "COV"]) {
      expect(outThisWeek(word)).toBe(true);
    }
  });

  it("leaves questionable and doubtful players playing", () => {
    expect(outThisWeek("Questionable")).toBe(false);
    expect(outThisWeek("Doubtful")).toBe(false);
  });

  it("takes a player with nothing said about him as playing", () => {
    expect(outThisWeek(null)).toBe(false);
    expect(outThisWeek(undefined)).toBe(false);
    expect(outThisWeek("")).toBe(false);
  });
});

/**
 * The rates come from the injury reports for 2018 to 2025, counted by the
 * injury status eval. Two thirds of questionable players play and about
 * one doubtful player in eighty does.
 */
describe("the chance a listed player plays", () => {
  it("gives a player nobody has said anything about the full week", () => {
    expect(playChance(null)).toBe(1);
    expect(playChance(undefined)).toBe(1);
    expect(playChance("")).toBe(1);
    expect(playChance("Probable")).toBe(1);
  });

  it("gives a player who has been ruled out nothing", () => {
    for (const word of ["Out", "IR", "PUP", "Sus", "DNR", "COV", "NA"]) {
      expect(playChance(word)).toBe(0);
    }
  });

  it("marks a questionable player down to about two thirds", () => {
    expect(playChance("Questionable")).toBeCloseTo(0.64);
  });

  it("prices a doubtful player about where an out one sits", () => {
    expect(playChance("Doubtful")).toBeLessThan(0.05);
  });

  it("splits questionable by what he did at practice", () => {
    expect(playChance("Questionable", "DNP")).toBeCloseTo(0.43);
    expect(playChance("Questionable", "Limited")).toBeCloseTo(0.66);
    expect(playChance("Questionable", "Full")).toBeCloseTo(0.75);
  });

  it("falls back to the status where no practice has been reported", () => {
    expect(playChance("Questionable", "Walkthrough"))
      .toBe(playChance("Questionable"));
    expect(playChance("Doubtful", "Full")).toBe(playChance("Doubtful"));
  });

  it("says which words move a projection at all", () => {
    expect(pricedDown("Questionable")).toBe(true);
    expect(pricedDown("Doubtful")).toBe(true);
    expect(pricedDown("Out")).toBe(true);
    expect(pricedDown(null)).toBe(false);
  });
});
