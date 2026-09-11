/**
 * The two things a waiver page has to get right: a better man at an
 * open seat is worth more than a worse one, and dropping somebody who
 * starts every week costs more than dropping somebody who never does.
 */

import { describe, expect, it } from "vitest";

import { addsFor, dropsFor } from "./waivers.ts";
import { weeksOf } from "./winShare.ts";
import type { Player } from "./scoring.ts";

const SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"];

const DRAWN = 400;

/** a man who scores about this much a week, with an ordinary spread */
const aMan = (
  name: string, position: string, ppg: number, games = 17,
): Player => ({
  name, key: name, position, games, ppg,
  game: {
    ev: ppg, mid: ppg, q1: ppg * 0.7, q3: ppg * 1.3,
    low: ppg * 0.4, high: ppg * 1.7,
  },
}) as Player;

const aRoster = () => [
  aMan("qb", "QB", 18), aMan("rb1", "RB", 15), aMan("rb2", "RB", 12),
  aMan("wr1", "WR", 14), aMan("wr2", "WR", 11), aMan("te", "TE", 9),
  aMan("flex", "WR", 10),
];

/** a side that scores about what ours does, so the comparison is live */
const anOpponent = (draws = DRAWN) => {
  const men = [
    aMan("theirQb", "QB", 18), aMan("theirRb1", "RB", 15),
    aMan("theirRb2", "RB", 12), aMan("theirWr1", "WR", 14),
    aMan("theirWr2", "WR", 11), aMan("theirTe", "TE", 9),
    aMan("theirFlex", "WR", 10), aMan("theirK", "K", 9),
  ];
  const weeks = men.map((p) => weeksOf(p, draws));

  return Array.from({ length: draws }, (_, i) =>
    weeks.reduce((sum, its) => sum + its[i]!, 0));
};

const aRoom = () => ({
  opponent: anOpponent(), wire: {}, draws: DRAWN,
});

describe("adding a man off the wire", () => {
  it("pays more for a better one at an open seat", () => {
    const pool = [aMan("goodK", "K", 11), aMan("poorK", "K", 6)];
    const adds = addsFor(aRoster(), pool, SLOTS, aRoom());
    const good = adds.find((a) => a.p.key === "goodK")!;
    const poor = adds.find((a) => a.p.key === "poorK")!;

    expect(good.added).toBeGreaterThan(poor.added);
    expect(adds[0]!.p.key).toBe("goodK");
    expect(good.starts).toBeGreaterThan(0.9);
  });
});

describe("dropping a man", () => {
  it("costs more for a starter than for a bench man", () => {
    const roster = [...aRoster(), aMan("rb5", "RB", 4)];
    const drops = dropsFor(roster, SLOTS, aRoom());
    const starter = drops.find((d) => d.p.key === "rb1")!;
    const bench = drops.find((d) => d.p.key === "rb5")!;

    expect(starter.costs).toBeGreaterThan(bench.costs);
    expect(starter.starts).toBeGreaterThan(bench.starts);
  });
});
