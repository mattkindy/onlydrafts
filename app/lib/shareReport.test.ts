import { describe, expect, it } from "vitest";

import {
  curveOf, layoutReport, reportTextOf, spreadBarOf,
} from "./shareReport.ts";
import { WIDTH } from "./shareImage.ts";
import type { PlayerNote, Report } from "./weekReport.ts";

const spread = { ev: 12.4, q1: 8, mid: 12, q3: 17, low: 4, high: 24 };

const note = (
  name: string, owner: string, points: number, quantile = 0.96,
): PlayerNote => ({
  key: name,
  name,
  position: "QB",
  owner,
  points,
  line: 12.4,
  spread,
  quantile,
});

const report: Report = {
  league: "Dynasty Warriors",
  week: 3,
  games: 3,
  finished: 3,
  provisional: false,
  player: note("Josh Allen", "Ace", 34.2),
  manager: {
    award: "beater", owner: "Ace", figure: "+20.00",
    note: "140.00, projected 120.00",
  },
  awards: [
    { award: "highest", owner: "Ace", figure: "140.00", note: "against Bea" },
    {
      award: "stolen", owner: "Cy", figure: "31%",
      note: "31% to win, beat Dot by 0.50", fill: 0.31, won: true,
    },
  ],
  scores: [
    { owner: "Ace", points: 140, best: 150, won: true },
    { owner: "Bea", points: 70, best: 80, won: false },
  ],
  median: 105,
  positions: [
    {
      position: "QB",
      over: note("Josh Allen", "Ace", 34.2),
      under: note("Bo Nix", "Bea", 4.1, 0.04),
    },
    { position: "RB", over: null, under: null },
  ],
  best: [note("Josh Allen", "Ace", 34.2)],
  worst: [note("Bo Nix", "Bea", 4.1, 0.04)],
  benched: [
    {
      key: "Rico Dowdle", name: "Rico Dowdle", position: "RB",
      owner: "Bea", points: 28.4,
    },
  ],
  zeroes: [{ owner: "Dot", names: ["Bye Guy"] }],
  stack: {
    owner: "Ace", team: "BUF", names: ["Josh Allen", "Khalil Shakir"],
    points: 61.4,
  },
  freeAgents: {
    scoredBy: "league",
    top: {
      key: "Free Man", name: "Free Man", position: "WR",
      owner: "free agent", points: 30.1,
    },
    positions: [
      {
        position: "WR",
        top: {
          key: "Free Man", name: "Free Man", position: "WR",
          owner: "free agent", points: 30.1,
        },
      },
      { position: "QB", top: null },
    ],
  },
};

describe("layoutReport", () => {
  it("stacks the blocks down the page without overlapping", () => {
    const layout = layoutReport(report);

    expect(layout.width).toBe(WIDTH);

    let bottom = 0;

    for (const block of layout.blocks) {
      expect(block.y).toBeGreaterThanOrEqual(bottom);
      bottom = block.y + block.height;
    }

    expect(layout.height).toBeGreaterThan(bottom);
  });

  it("leads with the player and the manager of the week", () => {
    const [first, second] = layoutReport(report).blocks;

    expect(first?.title).toBe("headliners");
    expect(second?.kind).toBe("scores");
    expect(first?.kind === "rows" && first.rows.map((row) => row.label))
      .toEqual(["player of the week", "manager of the week"]);
  });

  it("heads the picture with the league and the week", () => {
    const layout = layoutReport(report);

    expect(layout.title).toBe("Dynasty Warriors");
    expect(layout.subtitle).toBe("week 3 recap");
    expect(layout.footer).toBe("onlydrafts");
    expect(layout.note).toBe(null);
  });

  it("says how far a provisional week has got", () => {
    const layout = layoutReport({ ...report, finished: 1, provisional: true });

    expect(layout.note).toBe("1 of 3 games final, numbers will move");
    expect(reportTextOf(layout)).toContain("1 of 3 games final, numbers will move");
  });

  it("says the awards, the players, and their lines", () => {
    const said = reportTextOf(layoutReport(report));

    expect(said).toContain("top score");
    expect(said).toContain("Ace");
    expect(said).toContain("140.00");
    expect(said).toContain("QB best");
    expect(said).toContain("Josh Allen");
    expect(said).toContain("Ace, line 12.4, 1 in 25 good");
    expect(said).toContain("median 105.00");
    expect(said).toContain("BUF stack");
    expect(said[0]).toBe("Dynasty Warriors");
    expect(said[said.length - 1]).toBe("onlydrafts");
  });

  it("draws a bar beside a player and beside an upset", () => {
    const blocks = layoutReport(report).blocks;
    const week = blocks.find(
      (block) => block.kind === "rows" && block.title === "awards");
    const kinds = week?.kind === "rows"
      ? week.rows.map((row) => row.chart?.kind ?? null)
      : [];

    expect(kinds).toEqual([null, "fill"]);

    const two = blocks[0];

    expect(two?.kind === "rows" && two.rows[0]?.chart?.kind).toBe("curve");
  });

  it("leaves a block out when the week has nothing for it", () => {
    const layout = layoutReport({
      ...report,
      player: null,
      manager: null,
      awards: [],
      scores: [],
      best: [],
      worst: [],
      benched: [],
      zeroes: [],
      stack: null,
      freeAgents: null,
    });

    expect(layout.blocks.map((block) => block.title))
      .toEqual(["best and worst by position"]);
  });

  it("keeps every line short enough for a phone to read", () => {
    for (const line of reportTextOf(layoutReport(report))) {
      expect(line.length).toBeLessThanOrEqual(48);
    }
  });
});

describe("spreadBarOf", () => {
  it("puts the middle half inside the whole spread", () => {
    const bar = spreadBarOf(spread, 12);

    expect(bar.q1).toBeGreaterThan(0);
    expect(bar.q3).toBeLessThan(1);
    expect(bar.at).toBeCloseTo(bar.mid);
    expect(bar.beyond).toBe(false);
  });

  it("stretches the bar for a week outside the spread", () => {
    const bar = spreadBarOf(spread, 40);

    expect(bar.at).toBeCloseTo(1);
    expect(bar.beyond).toBe(true);
  });
});

describe("curveOf", () => {
  const spread = { ev: 12.4, q1: 8, mid: 12, q3: 17, low: 4, high: 24 };

  it("rises to a peak in the middle and falls away on both sides", () => {
    const { line } = curveOf(spread, 12);
    const tallest = line.reduce(
      (best, point, at) => (point[1] > line[best]![1] ? at : best), 0);

    expect(tallest).toBeGreaterThan(line.length * 0.2);
    expect(tallest).toBeLessThan(line.length * 0.8);
    expect(line[0]![1]).toBeLessThan(0.2);
    expect(line.at(-1)![1]).toBeLessThan(0.2);
    expect(Math.max(...line.map((point) => point[1]))).toBe(1);
  });

  it("goes left to right across the box, never outside it", () => {
    const { line } = curveOf(spread, 12);

    for (const [at, [x, y]] of line.entries()) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
      expect(y).toBeGreaterThanOrEqual(0);

      if (at > 0) {
        expect(x).toBeGreaterThan(line[at - 1]![0]);
      }
    }
  });

  it("makes room for a week past the end of the curve", () => {
    const far = curveOf(spread, 60);

    expect(far.at).toBe(1);
    expect(far.high).toBe(true);
    expect(far.line.at(-1)![0]).toBeLessThan(1);
  });

  it("marks a week under the middle as a low one", () => {
    expect(curveOf(spread, 2).high).toBe(false);
  });
});
