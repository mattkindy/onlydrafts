import { describe, expect, it } from "vitest";

import { fractionLeft, oddsFor, sideTotals, statesFrom } from "./matchups.ts";
import type { GameState } from "./matchups.ts";
import type { Matchup, Side } from "./providers.ts";
import type { SlateRow } from "./slate.ts";

const row = (name: string, team: string, blend: number): SlateRow => ({
  playerId: name,
  name,
  position: "WR",
  team,
  opponent: "NE",
  home: true,
  ours: blend,
  sleeper: blend,
  blend,
  floor: blend * 0.4,
  ceiling: blend * 1.8,
  questionable: false,
  gamesMissedRecent: 0,
  absenceShare: 0,
});

const rowsFor = (...rows: SlateRow[]) =>
  new Map(rows.map((r) => [r.name, r]));

const side = (
  owner: string, points: number, starters: Side["starters"],
): Side => ({ owner, points, starters, bench: [] });

const states = (of: Record<string, GameState>) =>
  new Map(Object.entries(of));

describe("oddsFor", () => {
  it("gives a side that is ahead with every game over the whole thing", () => {
    const rows = rowsFor(row("ahead", "BUF", 12), row("behind", "MIA", 12));
    const matchup: Matchup = {
      sides: [
        side("me", 100, [{ key: "ahead", slot: "WR", points: 100 }]),
        side("you", 80, [{ key: "behind", slot: "WR", points: 80 }]),
      ],
    };
    const [mine, theirs] = oddsFor(
      matchup,
      rows,
      states({ BUF: { where: "post", left: 0 }, MIA: { where: "post", left: 0 } }),
      500,
    );

    expect(mine).toBe(1);
    expect(theirs).toBe(0);
  });

  it("keeps a big lead with one man left to play", () => {
    const rows = rowsFor(row("done", "BUF", 12), row("late", "LA", 14));
    const matchup: Matchup = {
      sides: [
        side("me", 132, [{ key: "done", slot: "WR", points: 132 }]),
        side("you", 100, [
          { key: "done", slot: "WR", points: 100 },
          { key: "late", slot: "WR", points: 0 },
        ]),
      ],
    };
    const [mine] = oddsFor(
      matchup,
      rows,
      states({
        BUF: { where: "post", left: 0 },
        LA: { where: "pre", left: 1 },
      }),
      2000,
    );

    expect(mine).toBeGreaterThan(0.9);
  });

  it("adds a scaled draw to what a man in a live game has already", () => {
    const rows = rowsFor(row("playing", "KC", 20));
    const totals = sideTotals(
      side("me", 8, [{ key: "playing", slot: "WR", points: 8 }]),
      rows,
      states({ KC: { where: "in", left: 0.5 } }),
      4000,
    );
    const mean = totals.reduce((sum, n) => sum + n, 0) / totals.length;

    // eight on the board plus half of a twenty point week
    expect(mean).toBeGreaterThan(8 + 0.5 * 20 - 1.5);
    expect(mean).toBeLessThan(8 + 0.5 * 20 + 1.5);
  });

  it("scores a starter the week has no projection for on points alone", () => {
    const totals = sideTotals(
      side("me", 5, [{ key: "nobody", slot: "K", points: 5 }]),
      new Map(),
      states({}),
      20,
    );

    expect(new Set(totals)).toEqual(new Set([5]));
  });
});

describe("fractionLeft", () => {
  it("counts the quarters still to come and the clock in this one", () => {
    expect(fractionLeft(1, "15:00")).toBeCloseTo(1, 5);
    expect(fractionLeft(3, "15:00")).toBeCloseTo(0.5, 5);
    expect(fractionLeft(4, "0:00")).toBeCloseTo(0, 5);
    expect(fractionLeft(5, "10:00")).toBeCloseTo(10 / 60, 5);
  });
});

describe("statesFrom", () => {
  it("reads both sides of a game and renames the codes the board spells differently", () => {
    const got = statesFrom({
      events: [{
        competitions: [{
          status: { period: 2, displayClock: "7:30", type: { state: "in" } },
          competitors: [
            { team: { abbreviation: "WSH" } },
            { team: { abbreviation: "LAR" } },
          ],
        }],
      }, {
        status: { type: { state: "pre" } },
        competitions: [{
          competitors: [
            { team: { abbreviation: "JAX" } },
            { team: { abbreviation: "NE" } },
          ],
        }],
      }],
    });

    expect(got.get("WAS")).toEqual({
      where: "in", left: (30 + 7.5) / 60,
    });
    expect(got.get("LA")?.where).toBe("in");
    expect(got.get("JAX")).toEqual({ where: "pre", left: 1 });
    expect(got.has("WSH")).toBe(false);
  });
});
