import { describe, expect, it } from "vitest";
import {
  blankPlayerWeek,
  type GameRow, type PlayerWeekStats, type SnapCountWeek,
} from "../data/nflverse.js";
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
    ...blankPlayerWeek(),
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
    indoors: false,
    divisional: false,
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

  it("turns the home spread line around for the away side", () => {
    const lined = [1, 2, 3, 4, 5].map((w) => ({ ...game(w), spreadLine: 3 }));
    const home = buildWeeklyExamples(2023, stats, new Map(), lined, [], presets.ppr);
    const away = buildWeeklyExamples(
      2023,
      stats.map((s) => ({ ...s, teamId: "KC" })),
      new Map(),
      lined,
      [],
      presets.ppr,
    );

    expect(home[0]!.spread).toBe(3);
    expect(away[0]!.spread).toBe(-3);
  });

  it("leaves the spread at zero when the game has no line", () => {
    const examples = buildWeeklyExamples(
      2023,
      stats,
      new Map(),
      [1, 2, 3, 4, 5].map(game),
      [],
      presets.ppr,
    );

    expect(examples[0]!.spread).toBe(0);
  });
});

function backWeek(
  playerId: string,
  week: number,
  carries: number,
  targets: number,
): PlayerWeekStats {
  return {
    ...statWeek(week, 0),
    playerId,
    playerName: playerId,
    position: "RB",
    carries,
    targets,
  };
}

describe("backfield share", () => {
  const games = [1, 2, 3, 4, 5].map(game);

  it("gives each back his cut of what the room was given", () => {
    const rows = [1, 2, 3, 4, 5].flatMap((w) => [
      backWeek("starter", w, 12, 3),
      backWeek("backup", w, 4, 1),
    ]);
    const examples = buildWeeklyExamples(2023, rows, new Map(), games, [], presets.ppr);
    const byId = new Map(examples.map((e) => [e.playerId, e]));

    expect(byId.get("starter")!.backfieldShareRecent).toBeCloseTo(0.75);
    expect(byId.get("backup")!.backfieldShareRecent).toBeCloseTo(0.25);
  });

  it("is zero for a position that is not a back", () => {
    const examples = buildWeeklyExamples(
      2023,
      [1, 2, 3, 4, 5].map((w) => statWeek(w, 100)),
      new Map(),
      games,
      [],
      presets.ppr,
    );

    expect(examples[0]!.backfieldShareRecent).toBe(0);
  });

  it("is zero for a week nobody in the room touched it", () => {
    const rows = [1, 2, 3, 4, 5].map((w) => backWeek("starter", w, 0, 0));
    const examples = buildWeeklyExamples(2023, rows, new Map(), games, [], presets.ppr);

    expect(examples[0]!.backfieldShareRecent).toBe(0);
  });
});
