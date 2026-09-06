import { describe, expect, it } from "vitest";
import {
  blankPlayerWeek,
  type GameRow, type PlayerWeekStats, type SnapCountWeek,
} from "../data/nflverse.js";
import { emptyStatLine, presets } from "../scoring/fantasyPoints.js";
import type { WeeklyAvailability, WeekStatus } from "../data/weeklyStatus.js";
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

function ruledOut(playerIds: string[], week: number): WeeklyAvailability {
  const blank: WeekStatus = {
    out: true,
    questionable: false,
    limitedPractice: false,
    team: "DET",
    position: "RB",
  };
  const status = new Map(
    playerIds.map((id) => [`${id}|${week}`, blank] as const),
  );

  return { status, depth: { covered: false, rankFor: () => undefined } };
}

function passWeek(playerId: string, week: number, attempts: number): PlayerWeekStats {
  return {
    ...statWeek(week, 0),
    playerId,
    playerName: playerId,
    position: "QB",
    passing: { attempts, completions: 0, airYards: 0, sacksTaken: 0 },
  };
}

describe("absence share", () => {
  const games = [1, 2, 3, 4, 5].map(game);
  const room = [1, 2, 3, 4, 5].flatMap((w) => [
    backWeek("starter", w, 12, 3),
    backWeek("backup", w, 4, 1),
  ]);

  it("hands the backup the touches of the man ruled out", () => {
    const examples = buildWeeklyExamples(
      2023, room, new Map(), games, [], presets.ppr, undefined, undefined,
      ruledOut(["starter"], 5),
    );

    expect(examples.map((e) => e.playerId)).toEqual(["backup"]);
    expect(examples[0]!.absenceShare).toBeCloseTo(0.75);
  });

  it("is zero when the whole room is available", () => {
    const examples = buildWeeklyExamples(
      2023, room, new Map(), games, [], presets.ppr, undefined, undefined,
      ruledOut([], 5),
    );

    expect(examples.every((e) => e.absenceShare === 0)).toBe(true);
  });

  it("ignores a man ruled out in a different room", () => {
    const rows = [...room, ...[1, 2, 3, 4, 5].map((w) => passWeek("qb", w, 30))];
    const examples = buildWeeklyExamples(
      2023, rows, new Map(), games, [], presets.ppr, undefined, undefined,
      ruledOut(["qb"], 5),
    );
    const byId = new Map(examples.map((e) => [e.playerId, e]));

    expect(byId.get("starter")!.absenceShare).toBe(0);
    expect(byId.get("starter")!.qbAbsenceShare).toBeCloseTo(1);
    expect(byId.has("qb")).toBe(false);
  });

  it("leaves a quarterback's own room out of his quarterback measure", () => {
    const rows = [1, 2, 3, 4, 5].flatMap((w) => [
      passWeek("qb1", w, 30),
      passWeek("qb2", w, 10),
    ]);
    const examples = buildWeeklyExamples(
      2023, rows, new Map(), games, [], presets.ppr, undefined, undefined,
      ruledOut(["qb1"], 5),
    );

    expect(examples[0]!.playerId).toBe("qb2");
    expect(examples[0]!.absenceShare).toBeCloseTo(0.75);
    expect(examples[0]!.qbAbsenceShare).toBe(0);
  });
});

describe("depth chart join", () => {
  const games = [1, 2, 3, 4, 5].map(game);
  const rows = [1, 2, 3, 4, 5].map((w) => statWeek(w, 100));

  const withRanks = (ranks: Map<string, number>): WeeklyAvailability => ({
    status: new Map(),
    depth: {
      covered: true,
      rankFor: (playerId, week) => ranks.get(`${playerId}|${week}`),
    },
  });

  it("takes the standing published for that very week", () => {
    const examples = buildWeeklyExamples(
      2023, rows, new Map(), games, [], presets.ppr, undefined, undefined,
      withRanks(new Map([["p1|4", 1], ["p1|5", 2]])),
    );

    expect(examples[0]!.week).toBe(5);
    expect(examples[0]!.depthRank).toBe(2);
    expect(examples[0]!.depthKnown).toBe(true);
  });

  it("says it does not know when the man is off the chart", () => {
    const examples = buildWeeklyExamples(
      2023, rows, new Map(), games, [], presets.ppr, undefined, undefined,
      withRanks(new Map()),
    );

    expect(examples[0]!.depthRank).toBe(0);
    expect(examples[0]!.depthKnown).toBe(false);
  });

  it("says it does not know when the season has no chart at all", () => {
    const examples = buildWeeklyExamples(
      2023, rows, new Map(), games, [], presets.ppr, undefined, undefined,
      ruledOut([], 5),
    );

    expect(examples[0]!.depthKnown).toBe(false);
  });
});
