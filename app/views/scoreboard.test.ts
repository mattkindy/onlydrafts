import { describe, expect, it } from "vitest";

import type { GameState } from "../lib/matchups.ts";
import { nextReadIn } from "./scoreboard.ts";

const PRE: GameState = { where: "pre", left: 1 };
const IN: GameState = { where: "in", left: 0.5 };
const POST: GameState = { where: "post", left: 0 };

const week = (...states: GameState[]) =>
  new Map(states.map((s, at) => [`T${at}`, s]));

const NOW = Date.parse("2026-09-27T14:00:00Z");
const MINUTE = 60_000;

describe("nextReadIn", () => {
  it("keeps reading on a Sunday morning before any game has started", () => {
    const wait = nextReadIn(week(PRE, PRE), NOW + 3 * MINUTE, NOW);

    expect(wait).toBe(3 * MINUTE);
  });

  it("waits no longer than half an hour for a kickoff days away", () => {
    expect(nextReadIn(week(PRE), NOW + 3 * 24 * 60 * MINUTE, NOW))
      .toBe(30 * MINUTE);
  });

  it("reads every minute while a game is on", () => {
    expect(nextReadIn(week(IN, PRE), NOW + 180 * MINUTE, NOW)).toBe(MINUTE);
  });

  it("reads every minute for a game past its kickoff that has not started", () => {
    expect(nextReadIn(week(POST, PRE), NOW - 5 * MINUTE, NOW)).toBe(MINUTE);
  });

  it("stops once every game is over", () => {
    expect(nextReadIn(week(POST, POST), null, NOW)).toBeNull();
  });

  it("tries again in a minute when the last read failed", () => {
    expect(nextReadIn(null, null, NOW)).toBe(MINUTE);
  });
});
