/**
 * The bar a kicker and a defence are measured against.
 *
 * What makes these two different from a back is that you replace them
 * during the season rather than keeping them, so the man you are really
 * weighing them against is on the wire and not on a bench.
 */

import { describe, expect, it } from "vitest";

import { keptAt, offWaivers, replacementBar } from "./replacementPool.ts";
import type { Player } from "./scoring.ts";
import type { Roster } from "./providers.ts";

const aDefence = (name: string, ppg: number): Player =>
  ({ name, key: name, position: "DEF", ppg }) as Player;

const aKicker = (name: string, ppg: number): Player =>
  ({ name, key: name, position: "K", ppg }) as Player;

/** thirty-two of them, each a tenth of a point worse than the last */
const defences = Array.from({ length: 32 }, (_, i) =>
  aDefence(`D${i + 1}`, 6 - i * 0.1));

const kickers = Array.from({ length: 30 }, (_, i) =>
  aKicker(`K${i + 1}`, 10 - i * 0.1));

const rostered = (position: string, howMany: number): Roster[] =>
  Array.from({ length: howMany }, (_, i) => ({
    owner: `team ${i}`,
    picks: [],
    keys: [{ name: `${position}${i}`, key: `${position}${i}`, pos: position }],
  })) as Roster[];

describe("how many the room keeps", () => {
  it("counts the rosters when the league has told us", () => {
    expect(keptAt("DEF", 12, rostered("DEF", 20))).toBe(20);
  });

  it("falls back to one a team before anybody has drafted", () => {
    expect(keptAt("DEF", 12, [])).toBe(12);
    expect(keptAt("DEF", 12, null)).toBe(12);
  });

  /**
   * The meta is the thing a fitted number cannot survive. A room that
   * decides to keep two defences each thins the pool by itself, and the
   * bar has to move with it rather than with what rooms did in 2023.
   */
  it("moves the bar when the room starts keeping two each", () => {
    const thin = offWaivers(defences, "DEF", 12, rostered("DEF", 24))!;
    const usual = offWaivers(defences, "DEF", 12, rostered("DEF", 12))!;

    expect(thin).toBeLessThan(usual);
  });
});

describe("what the wire gives you", () => {
  /**
   * Choosing a defence weekly on the betting line beat keeping the best
   * one left, once the rest of the room is streaming too. A kicker gains
   * nothing he can be shown to gain, so he gets no credit.
   */
  it("pays a defence for being streamable and a kicker not", () => {
    const defenceBar = offWaivers(defences, "DEF", 12, null)!;
    const thirteenth = defences[12]!.ppg!;

    expect(defenceBar).toBeCloseTo(thirteenth + 1.4, 5);

    const kickerBar = offWaivers(kickers, "K", 12, null)!;

    expect(kickerBar).toBeCloseTo(kickers[12]!.ppg!, 5);
  });

  it("says nothing when there is nobody left to pick up", () => {
    expect(offWaivers(defences.slice(0, 8), "DEF", 12, null)).toBeNull();
  });

  /**
   * A back is kept, so the last man the league starts is who you would
   * play instead of him. Only the streamed two are moved off that.
   */
  it("leaves every other position on the last starter", () => {
    const bar = replacementBar({
      men: [...defences, ...kickers],
      teams: 12,
      rosters: null,
      lastStarter: { QB: 14, RB: 9, WR: 8, TE: 6, K: 8.8, DEF: 2.4 },
    });

    expect(bar["RB"]).toBe(9);
    expect(bar["QB"]).toBe(14);
    expect(bar["DEF"]).toBeGreaterThan(2.4);
  });
});
