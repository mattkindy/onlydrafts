/**
 * A team that drafted better men from the same slots rates higher, and
 * a pick the board would have made reads as its own best choice.
 */

import { describe, expect, it } from "vitest";

import { sharePicks, shareTeams, type Room } from "./draftShare.ts";
import type { Player } from "./scoring.ts";

const SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"];

const aMan = (
  name: string, position: string, ppg: number, adp: number,
): Player => ({
  name, key: name, position, games: 17, ppg, adp, rank: adp,
  game: {
    ev: ppg, mid: ppg, q1: ppg * 0.7, q3: ppg * 1.3,
    low: ppg * 0.4, high: ppg * 1.7,
  },
}) as Player;

/** two of everything, the first better than the second, priced in order */
const board = (): Player[] => {
  const men: Player[] = [];
  let adp = 1;

  for (const [position, ppg] of [
    ["RB", 18], ["WR", 16], ["QB", 22], ["TE", 10], ["K", 8], ["DEF", 7],
  ] as const) {
    for (let i = 0; i < 4; i++) {
      men.push(aMan(`${position}${i}`, position, ppg - 2 * i, adp++));
    }
  }

  return men;
};

const aRoom = (): Room => ({
  opponent: Array.from({ length: 400 }, () => 60),
  wire: { QB: 12, RB: 6, WR: 6, TE: 4, K: 6, DEF: 5 },
  draws: 400,
});

describe("shareTeams", () => {
  it("rates the side that got the better men higher from the same slots", () => {
    const men = board();
    const byKey = new Map(men.map((p) => [p.key, p]));
    const picks = [1, 4, 5, 8, 9, 12, 13, 16, 17];
    const roster = (i: number) =>
      ["QB", "RB", "RB", "WR", "WR", "TE", "K", "DEF"].map((where, k) => ({
        at: picks[k]!, p: byKey.get(`${where}${i + (where === "RB" && k === 2 ? 1 : 0)}`)!, kept: false,
      }));
    const rated = shareTeams(
      [{ owner: "good", took: roster(0) }, { owner: "poor", took: roster(2) }],
      men, SLOTS, aRoom(),
    );

    expect(rated[0]!.owner).toBe("good");
    expect(rated[0]!.wins).toBeGreaterThan(rated[1]!.wins);
    expect(rated[0]!.over).toBeGreaterThan(rated[1]!.over);
  });
});

describe("sharePicks", () => {
  it("reads the man the board would have taken as its own best choice", () => {
    const men = board();
    const room = aRoom();
    const took = [{ at: 1, p: men[0]!, kept: false }];
    const [first] = sharePicks(took, took, men, SLOTS, room);

    expect(first!.best === null || first!.best.share.added > first!.share.added).toBe(true);
    expect(first!.share.added).toBeGreaterThan(0);
  });
});
