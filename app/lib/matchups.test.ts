import { describe, expect, it } from "vitest";

import {
  bestLineupFor, fractionLeft, liveDraws, oddsFor, sideTotals, starterState,
  statesFrom,
} from "./matchups.ts";
import type { GameState } from "./matchups.ts";
import type { Matchup, Side } from "./providers.ts";
import type { SlateRow } from "./slate.ts";
import { weeksFromSpread } from "./spread.ts";

const row = (
  name: string, team: string, blend: number,
  position = "WR", opponent = "NE",
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

function corr(a: number[], b: number[]): number {
  const mean = (its: number[]) =>
    its.reduce((sum, n) => sum + n, 0) / its.length;
  const [ma, mb] = [mean(a), mean(b)];
  let top = 0;
  let sa = 0;
  let sb = 0;

  for (let i = 0; i < a.length; i++) {
    top += (a[i]! - ma) * (b[i]! - mb);
    sa += (a[i]! - ma) ** 2;
    sb += (b[i]! - mb) ** 2;
  }

  return top / Math.sqrt(sa * sb);
}

const mean = (its: number[]) =>
  its.reduce((sum, n) => sum + n, 0) / its.length;

const at = (its: number[], q: number) =>
  [...its].sort((a, b) => a - b)[Math.floor(q * its.length)]!;

describe("liveDraws", () => {
  const stack = rowsFor(
    row("qb", "BUF", 22, "QB", "MIA"),
    row("wr", "BUF", 18, "WR", "MIA"),
    row("def", "MIA", 8, "DEF", "BUF"),
    row("far", "KC", 16, "WR", "DEN"),
  );
  const toPlay = states({
    BUF: { where: "pre", left: 1 },
    MIA: { where: "pre", left: 1 },
    KC: { where: "pre", left: 1 },
    DEN: { where: "pre", left: 1 },
  });
  const men = ["qb", "wr", "def", "far"].map((key) => ({ key, points: 0 }));

  it("moves two men in the same game together and leaves two games apart", () => {
    const live = liveDraws(men, stack, toPlay, 4000);

    expect(corr(live.toCome("qb"), live.toCome("wr"))).toBeGreaterThan(0.3);
    expect(Math.abs(corr(live.toCome("qb"), live.toCome("far"))))
      .toBeLessThan(0.05);
  });

  it("leaves a man's own week where it was before anybody shared a factor", () => {
    const live = liveDraws(men, stack, toPlay, 8000);
    const his = live.toCome("wr");
    const alone = weeksFromSpread(
      { ev: 18, mid: 18, low: 7.2, high: 32.4, q1: 12.6, q3: 25.2 },
      "wr",
      8000,
    );

    expect(mean(his)).toBeCloseTo(mean(alone), 0);

    for (const q of [0.1, 0.5, 0.9]) {
      expect(at(his, q)).toBeCloseTo(at(alone, q), 0);
    }
  });

  it("lifts a teammate and sinks the other defence when a man runs hot", () => {
    const half = states({
      BUF: { where: "in", left: 0.5 },
      MIA: { where: "in", left: 0.5 },
      KC: { where: "pre", left: 1 },
      DEN: { where: "pre", left: 1 },
    });
    const otherwise = ["wr", "def", "far"].map((key) => ({ key, points: 0 }));
    const onPace = liveDraws(
      [{ key: "qb", points: 11 }, ...otherwise], stack, half, 6000);
    const hot = liveDraws(
      [{ key: "qb", points: 34 }, ...otherwise], stack, half, 6000);

    expect(mean(hot.toCome("wr"))).toBeGreaterThan(mean(onPace.toCome("wr")));
    expect(mean(hot.toCome("def"))).toBeLessThan(mean(onPace.toCome("def")));
    expect(hot.toCome("far")).toEqual(onPace.toCome("far"));
  });
});

describe("a man the slate leaves out", () => {
  const board = new Map([["buf", {
    name: "BUF",
    key: "buf",
    position: "DEF",
    team: "BUF",
    game: { ev: 9, q1: 5, mid: 8.5, q3: 12, low: 3, high: 16 },
  }]]);

  it("draws his week off the board when the week has no row for him", () => {
    const totals = sideTotals(
      side("me", 0, [{ key: "buf", slot: "DEF", points: 0 }]),
      new Map(),
      states({ BUF: { where: "pre", left: 1 } }),
      4000,
      undefined,
      board,
    );

    expect(mean(totals)).toBeGreaterThan(6);
    expect(mean(totals)).toBeLessThan(12);
  });

  it("says nothing about a man neither the week nor the board has", () => {
    expect(starterState({ key: "nobody" }, new Map(), states({}), board))
      .toBeNull();
    expect(starterState({ key: "buf" }, new Map(), states({}), board))
      .toEqual({ where: "pre", left: 1 });
  });
});

describe("bestLineupFor", () => {
  const rows = rowsFor(
    row("scrub", "BUF", 4),
    row("stud", "KC", 22),
    row("kept", "DEN", 14),
    row("locked", "LA", 3),
  );
  const yetToPlay = states({
    BUF: { where: "pre", left: 1 },
    KC: { where: "pre", left: 1 },
    DEN: { where: "pre", left: 1 },
    LA: { where: "in", left: 0.5 },
  });
  const them = side("you", 0, [{ key: "kept", slot: "WR", points: 0 }]);

  it("starts the better man off the bench", () => {
    const mine: Side = {
      owner: "me",
      points: 0,
      starters: [{ key: "scrub", slot: "WR", points: 0 }],
      bench: [{ key: "stud", points: 0 }],
    };
    const best = bestLineupFor(mine, them, ["WR"], rows, yetToPlay, 3000);

    expect(best.swaps).toHaveLength(1);
    expect(best.swaps[0]).toMatchObject({ starts: "stud", benches: "scrub", slot: "WR" });
    expect(best.starters.map((s) => s.key)).toEqual(["stud"]);
    expect(best.odds).toBeGreaterThan(0.5);
  });

  it("leaves a starter whose game has kicked off where he is", () => {
    const mine: Side = {
      owner: "me",
      points: 2,
      starters: [{ key: "locked", slot: "WR", points: 2 }],
      bench: [{ key: "stud", points: 0 }],
    };
    const best = bestLineupFor(mine, them, ["WR"], rows, yetToPlay, 3000);

    expect(best.swaps).toEqual([]);
    expect(best.starters.map((s) => s.key)).toEqual(["locked"]);
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
