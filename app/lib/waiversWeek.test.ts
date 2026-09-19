/**
 * What the week has to get right: a player on the bench costs nothing to drop
 * this week, a player in a slot costs whoever would fill it behind him, and a
 * newcomer is priced in the slot he would actually take.
 */

import { describe, expect, it } from "vitest";

import type { GameState, Lines } from "./matchups.ts";
import type { Side } from "./providers.ts";
import type { SlateRow } from "./slate.ts";
import { weekPricesFor, type WeekRoom } from "./waiversWeek.ts";
import type { Player } from "./scoring.ts";

const SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF", "BN"];

const DRAWN = 400;

const row = (
  name: string, position: string, blend: number, team = "NE",
  opponent = "BUF",
): SlateRow => ({
  playerId: name,
  name,
  position,
  team,
  opponent,
  home: true,
  ours: blend,
  sleeper: blend,
  blend,
  floor: blend * 0.4,
  ceiling: blend * 1.8,
  catches: 0,
  questionable: false,
  ruledOut: false,
  gamesMissedRecent: 0,
  absenceShare: 0,
});

/** everybody either side of this week's game, and what the week says of them */
const PLAYERS = [
  row("qb", "QB", 20), row("rb1", "RB", 16), row("rb2", "RB", 12),
  row("wr1", "WR", 15), row("wr2", "WR", 13), row("te", "TE", 9),
  row("flex", "WR", 10), row("k", "K", 8), row("def", "DEF", 7),
  row("benchWr", "WR", 6, "KC", "DEN"),
  row("theirQb", "QB", 20, "KC", "DEN"), row("theirRb1", "RB", 16, "KC", "DEN"),
  row("theirRb2", "RB", 12, "KC", "DEN"), row("theirWr1", "WR", 15, "KC", "DEN"),
  row("theirWr2", "WR", 13, "KC", "DEN"), row("theirTe", "TE", 9, "KC", "DEN"),
  row("theirFlex", "WR", 10, "KC", "DEN"), row("theirK", "K", 8, "KC", "DEN"),
  row("theirDef", "DEF", 7, "KC", "DEN"),
  row("bigWr", "WR", 18, "SF", "SEA"), row("poorWr", "WR", 3, "SF", "SEA"),
];

const ROWS = new Map(PLAYERS.map((r) => [r.name, r]));

const STATES = new Map<string, GameState>();

const LINES: Lines = new Map();

const aSide = (
  owner: string, inLineup: [string, string][], bench: string[],
): Side => ({
  owner,
  points: 0,
  starters: inLineup.map(([key, slot]) => ({ key, slot, points: 0 })),
  bench: bench.map((key) => ({ key, points: 0 })),
});

const MINE = aSide(
  "me",
  [
    ["qb", "QB"], ["rb1", "RB"], ["rb2", "RB"], ["wr1", "WR"], ["wr2", "WR"],
    ["te", "TE"], ["flex", "FLEX"], ["k", "K"], ["def", "DEF"],
  ],
  ["benchWr"],
);

const THEIRS = aSide(
  "them",
  [
    ["theirQb", "QB"], ["theirRb1", "RB"], ["theirRb2", "RB"],
    ["theirWr1", "WR"], ["theirWr2", "WR"], ["theirTe", "TE"],
    ["theirFlex", "FLEX"], ["theirK", "K"], ["theirDef", "DEF"],
  ],
  [],
);

const aRoom = (): WeekRoom => ({
  side: MINE,
  against: THEIRS,
  slots: SLOTS,
  rows: ROWS,
  states: STATES,
  lines: LINES,
  draws: DRAWN,
});

const aMan = (key: string, position: string): Player =>
  ({ name: key, key, position }) as Player;

describe("dropping one of yours this week", () => {
  it("costs nothing for a player who is not in the lineup", () => {
    const week = weekPricesFor(aRoom(), []);
    const his = week.drops.get("benchWr")!;

    expect(his.slot).toBeNull();
    expect(his.heir).toBeNull();
    expect(his.takes).toBe(0);
    expect(his.costs).toBe(0);
    expect(his.before).toBe(his.after);
  });

  it("names the slot and who takes it for a player who starts", () => {
    const week = weekPricesFor(aRoom(), []);
    const his = week.drops.get("wr1")!;

    expect(his.slot).toBe("WR");
    expect(his.heir).toBe("benchWr");
    expect(his.takes).toBeGreaterThan(0);
    expect(his.costs).toBeGreaterThan(0);
  });

  it("leaves a slot nobody can fill empty", () => {
    const week = weekPricesFor(aRoom(), []);
    const his = week.drops.get("k")!;

    expect(his.slot).toBe("K");
    expect(his.heir).toBeNull();
    expect(his.takes).toBeGreaterThan(0);
  });

  it("costs more to drop the better of two players in the same slot", () => {
    const week = weekPricesFor(aRoom(), []);

    expect(week.drops.get("rb1")!.costs)
      .toBeGreaterThan(week.drops.get("rb2")!.costs);
  });
});

describe("adding a player off the wire this week", () => {
  it("puts a better player in the slot of the one he beats", () => {
    const week = weekPricesFor(
      aRoom(), [{ p: aMan("bigWr", "WR"), drop: null }]);
    const his = week.adds.get("bigWr")!;

    expect(his.slot).not.toBeNull();
    expect(his.displaced).toBe("flex");
    expect(his.brings).toBeGreaterThan(0);
    expect(his.added).toBeGreaterThan(0);
  });

  it("leaves a player nobody would start out of the lineup", () => {
    const week = weekPricesFor(
      aRoom(), [{ p: aMan("poorWr", "WR"), drop: null }]);
    const his = week.adds.get("poorWr")!;

    expect(his.slot).toBeNull();
    expect(his.displaced).toBeNull();
    expect(his.brings).toBe(0);
    expect(his.added).toBe(0);
  });

  it("says nothing about a player the week has no line on", () => {
    const week = weekPricesFor(
      aRoom(), [{ p: aMan("nobody", "WR"), drop: null }]);

    expect(week.adds.has("nobody")).toBe(false);
    expect(week.nets.has("nobody")).toBe(false);
  });
});

describe("the whole move", () => {
  it("is worth what he adds when there is a spot open", () => {
    const week = weekPricesFor(
      aRoom(), [{ p: aMan("bigWr", "WR"), drop: null }]);

    expect(week.nets.get("bigWr")!.drop).toBeNull();
    expect(week.nets.get("bigWr")!.net)
      .toBeCloseTo(week.adds.get("bigWr")!.added, 10);
  });

  it("pays nothing this week for dropping a player off the bench", () => {
    const week = weekPricesFor(
      aRoom(), [{ p: aMan("bigWr", "WR"), drop: aMan("benchWr", "WR") }]);
    const paid = week.nets.get("bigWr")!;

    expect(paid.drop).toBe("benchWr");
    expect(paid.net).toBeGreaterThan(0);
  });

  it("gives the dropped player's slot to the newcomer where he fits it", () => {
    const week = weekPricesFor(
      aRoom(), [{ p: aMan("bigWr", "WR"), drop: aMan("wr2", "WR") }]);
    const paid = week.nets.get("bigWr")!;

    expect(paid.before).toBeCloseTo(week.odds, 10);
    expect(paid.net).toBeGreaterThan(0);
  });

  it("costs more than it pays when a starter goes for a worse player", () => {
    const week = weekPricesFor(
      aRoom(), [{ p: aMan("poorWr", "WR"), drop: aMan("wr1", "WR") }]);

    expect(week.nets.get("poorWr")!.net).toBeLessThan(0);
  });
});

describe("who you play", () => {
  it("says the other side's owner and how often you beat him", () => {
    const week = weekPricesFor(aRoom(), []);

    expect(week.opponent).toBe("them");
    expect(week.odds).toBeGreaterThan(0);
    expect(week.odds).toBeLessThan(1);
  });
});
