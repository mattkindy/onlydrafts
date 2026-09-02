/**
 * The board is built in the summer and a man goes on a list in
 * September, so the list has to be laid over the top of it.
 */

import { describe, expect, it } from "vitest";

import { gamesLeft, WEEKS_OUT } from "./availability.ts";

describe("what a man on a list is expected to play", () => {
  it("takes six games off him", () => {
    expect(gamesLeft(16.4, "IR")).toBe(17 - WEEKS_OUT);
    expect(gamesLeft(12.2, "PUP")).toBe(17 - WEEKS_OUT);
  });

  it("leaves a man who is merely questionable alone", () => {
    expect(gamesLeft(14.1, "Questionable")).toBe(14.1);
    expect(gamesLeft(14.1, null)).toBe(14.1);
  });

  /**
   * A man the board has already marked further down knows something
   * the word on the list does not say, so the lower number wins.
   */
  it("keeps a harsher number when the board has one", () => {
    expect(gamesLeft(4, "IR")).toBe(4);
  });

  it("takes a man with nothing said about him as playing them all", () => {
    expect(gamesLeft(undefined, null)).toBe(17);
  });
});

/**
 * NA reads like not active and means no designation. The men carrying
 * it are Peyton Hillis, Derek Carr and Adam Thielen: retired, or an old
 * note nobody cleared. Taking it for a spell out docked six games from
 * anybody with a stale flag, Brock Purdy among them.
 */
describe("a word that looks like it means out", () => {
  it("leaves a man marked NA where the board had him", () => {
    expect(gamesLeft(9.1, "NA")).toBe(9.1);
  });
});
