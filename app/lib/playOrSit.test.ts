import { describe, expect, it } from "vitest";

import type { GameState } from "./matchups.ts";
import { standingFor } from "./matchups.ts";
import { playOrSitFor } from "./playOrSit.ts";
import type { Matchup, Side } from "./providers.ts";
import { withOutPlayersZeroed, type SlateRow } from "./slate.ts";

const row = (
  name: string, team: string, blend: number, opponent: string, position = "WR",
): SlateRow => ({
  playerId: name, name, position, team, opponent, home: true,
  ours: blend, sleeper: blend, blend,
  floor: blend * 0.4, q1: blend * 0.7, q3: blend * 1.3, ceiling: blend * 1.8,
  catches: 0, questionable: false, ruledOut: false,
  gamesMissedRecent: 0, absenceShare: 0,
});

const side = (owner: string, starters: Side["starters"]): Side =>
  ({ owner, points: 0, starters, bench: [] });

const pre: GameState = { where: "pre", left: 1 };

/** two teams of two, with one of mine and one of theirs questionable */
function week(states: Record<string, GameState> = {}) {
  const raw = new Map([
    ["purdy", row("purdy", "SF", 18, "SEA", "QB")],
    ["mine", row("mine", "BUF", 12, "MIA")],
    ["theirs", row("theirs", "KC", 16, "LV")],
    ["other", row("other", "DAL", 14, "PHI")],
  ]);
  const rows = withOutPlayersZeroed(raw, new Map([
    ["purdy", { name: "purdy", status: "Questionable", position: "QB" }],
    ["theirs", { name: "theirs", status: "Questionable", position: "WR" }],
  ]));
  const matchup: Matchup = {
    sides: [
      side("me", [
        { key: "purdy", slot: "QB", points: 0 },
        { key: "mine", slot: "WR", points: 0 },
      ]),
      side("you", [
        { key: "theirs", slot: "WR", points: 0 },
        { key: "other", slot: "WR", points: 0 },
      ]),
    ],
  };
  const all = { SF: pre, SEA: pre, BUF: pre, MIA: pre, KC: pre, LV: pre,
    DAL: pre, PHI: pre, ...states };

  return { matchup, pricing: { rows, states: new Map(Object.entries(all)), draws: 2000 } };
}

describe("playOrSitFor", () => {
  it("prices each questionable starter played and sat, from your side", () => {
    const { matchup, pricing } = week();
    const now = standingFor(matchup, pricing).odds[0];
    const said = playOrSitFor(matchup, 0, pricing);
    const purdy = said.find((one) => one.key === "purdy")!;
    const theirs = said.find((one) => one.key === "theirs")!;

    expect(said).toHaveLength(2);
    expect(purdy.side).toBe(0);
    expect(purdy.chance).toBeCloseTo(0.64);
    // your own man playing helps you, and you are better off than now
    expect(purdy.plays).toBeGreaterThan(now);
    expect(purdy.sits).toBeLessThan(now);
    // theirs playing hurts you
    expect(theirs.side).toBe(1);
    expect(theirs.plays).toBeLessThan(now);
    expect(theirs.sits).toBeGreaterThan(now);
  });

  it("puts the biggest swing first", () => {
    const { matchup, pricing } = week();
    const [first, second] = playOrSitFor(matchup, 0, pricing);

    expect(Math.abs(first!.plays - first!.sits))
      .toBeGreaterThanOrEqual(Math.abs(second!.plays - second!.sits));
  });

  it("reads the same game from the other side", () => {
    const { matchup, pricing } = week();
    const mine = playOrSitFor(matchup, 0, pricing).find((one) => one.key === "purdy")!;
    const yours = playOrSitFor(matchup, 1, pricing).find((one) => one.key === "purdy")!;

    expect(mine.plays + yours.plays).toBeCloseTo(1, 5);
    expect(mine.sits + yours.sits).toBeCloseTo(1, 5);
  });

  it("leaves out a player whose game has started, since the news is in", () => {
    const { matchup, pricing } = week({ SF: { where: "in", left: 0.5 } });

    expect(playOrSitFor(matchup, 0, pricing).map((one) => one.key))
      .toEqual(["theirs"]);
  });

  it("finds nobody to price in a game with nobody in doubt", () => {
    const { matchup } = week();
    const rows = new Map([
      ["purdy", row("purdy", "SF", 18, "SEA", "QB")],
      ["mine", row("mine", "BUF", 12, "MIA")],
      ["theirs", row("theirs", "KC", 16, "LV")],
      ["other", row("other", "DAL", 14, "PHI")],
    ]);

    expect(playOrSitFor(matchup, 0, { rows, states: new Map(), draws: 500 }))
      .toEqual([]);
  });
});
