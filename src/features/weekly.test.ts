import { describe, expect, it } from "vitest";
import type { GameRow, PlayerWeekStats, SnapCountWeek } from "../data/nflverse.js";
import { emptyStatLine, presets } from "../scoring/fantasyPoints.js";
import { buildWeeklyExamples } from "./weekly.js";

function statWeek(week: number, recYds: number): PlayerWeekStats {
  return {
    playerId: "p1",
    playerName: "Test Player",
    position: "WR",
    season: 2023,
    week,
    teamId: "DET",
    statLine: { ...emptyStatLine(), recYds },
    targets: 0,
    carries: 0,
    airYards: 0,
  };
}

function game(week: number): GameRow {
  return {
    id: `2023_${week}_KC_DET`,
    season: 2023,
    week,
    homeTeamId: "DET",
    awayTeamId: "KC",
  };
}

function snap(week: number, offensePct: number): SnapCountWeek {
  return { playerName: "Test Player", teamId: "DET", season: 2023, week, offensePct };
}

describe("buildWeeklyExamples", () => {
  const stats = [1, 2, 3, 4, 5].map((w) => statWeek(w, 100));
  const games = [1, 2, 3, 4, 5].map(game);

  it("computes form features from earlier weeks only", () => {
    const examples = buildWeeklyExamples(
      2023,
      stats,
      new Map([["p1", 12]]),
      games,
      [],
      presets.ppr,
    );

    expect(examples).toHaveLength(1);
    const e = examples[0]!;
    expect(e.week).toBe(5);
    expect(e.target).toBe(10);
    expect(e.seasonPpg).toBe(10);
    expect(e.last4).toBe(10);
    expect(e.prevPpg).toBe(12);
    expect(e.home).toBe(true);
  });

  it("averages the last two snap weeks and scales percentages", () => {
    const examples = buildWeeklyExamples(
      2023,
      stats,
      new Map(),
      games,
      [snap(1, 20), snap(3, 0.6), snap(4, 0.8)],
      presets.ppr,
    );

    expect(examples[0]!.snapRecent).toBeCloseTo(0.7);
  });

  it("skips weeks with fewer than two earlier games", () => {
    const examples = buildWeeklyExamples(
      2023,
      [statWeek(4, 50), statWeek(5, 50), statWeek(6, 50)],
      new Map(),
      [4, 5, 6].map(game),
      [],
      presets.ppr,
    );

    expect(examples.map((e) => e.week)).toEqual([6]);
  });
});
