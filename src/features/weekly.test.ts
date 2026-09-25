import { describe, expect, it } from "vitest";
import {
  blankPlayerWeek,
  type GameRow, type PlayerWeekStats, type SnapCountWeek,
} from "../data/nflverse.js";
import { emptyStatLine, presets } from "../scoring/fantasyPoints.js";
import type { WeeklyAvailability, WeekStatus } from "../data/weeklyStatus.js";
import type { RosterAppearance } from "../graph/build.js";
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

  it("gives each back his cut of what the group was given", () => {
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

  it("is zero for a week nobody in the group touched it", () => {
    const rows = [1, 2, 3, 4, 5].map((w) => backWeek("starter", w, 0, 0));
    const examples = buildWeeklyExamples(2023, rows, new Map(), games, [], presets.ppr);

    expect(examples[0]!.backfieldShareRecent).toBe(0);
  });
});

function ruledOut(
  playerIds: string[], week: number, report = "Out",
): WeeklyAvailability {
  const blank: WeekStatus = {
    out: true,
    report,
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
  const group = [1, 2, 3, 4, 5].flatMap((w) => [
    backWeek("starter", w, 12, 3),
    backWeek("backup", w, 4, 1),
  ]);

  it("hands the backup the touches of the player ruled out", () => {
    const examples = buildWeeklyExamples(
      2023, group, new Map(), games, [], presets.ppr, undefined, undefined,
      ruledOut(["starter"], 5),
    );

    expect(examples.map((e) => e.playerId)).toEqual(["backup"]);
    expect(examples[0]!.absenceShare).toBeCloseTo(0.75);
  });

  it("is zero when the whole group is available", () => {
    const examples = buildWeeklyExamples(
      2023, group, new Map(), games, [], presets.ppr, undefined, undefined,
      ruledOut([], 5),
    );

    expect(examples.every((e) => e.absenceShare === 0)).toBe(true);
  });

  it("ignores a player ruled out in a different group", () => {
    const rows = [...group, ...[1, 2, 3, 4, 5].map((w) => passWeek("qb", w, 30))];
    const examples = buildWeeklyExamples(
      2023, rows, new Map(), games, [], presets.ppr, undefined, undefined,
      ruledOut(["qb"], 5),
    );
    const byId = new Map(examples.map((e) => [e.playerId, e]));

    expect(byId.get("starter")!.absenceShare).toBe(0);
    expect(byId.get("starter")!.qbAbsenceShare).toBeCloseTo(1);
    expect(byId.has("qb")).toBe(false);
  });

  it("leaves a quarterback's own group out of his quarterback measure", () => {
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

  const withPasser = [...group, ...[1, 2, 3, 4, 5].map((w) => passWeek("qb", w, 30))];
  const listedAs = (status: string, teamId = "DET"): RosterAppearance[] => [{
    playerId: "qb", name: "qb", rawPosition: "QB", teamId, season: 2023, week: 5, status,
  }];
  const qbShareWith = (rosters: RosterAppearance[]) =>
    buildWeeklyExamples(
      2023, withPasser, new Map(), games, [], presets.ppr, undefined, undefined,
      ruledOut([], 5), rosters,
    ).find((e) => e.playerId === "starter")!.qbAbsenceShare;

  it("counts a quarterback on a reserve list, whom the report never lists", () => {
    expect(qbShareWith(listedAs("RES"))).toBeCloseTo(1);
  });

  it("counts a quarterback who is now with another club", () => {
    expect(qbShareWith(listedAs("ACT", "KC"))).toBeCloseTo(1);
  });

  it("leaves a game-day inactive alone, since that is settled at kickoff", () => {
    expect(qbShareWith(listedAs("INA"))).toBe(0);
  });

  it("reads the reserve list for quarterbacks only", () => {
    const rosters: RosterAppearance[] = [{
      playerId: "starter", name: "starter", rawPosition: "RB", teamId: "DET",
      season: 2023, week: 5, status: "RES",
    }];
    const examples = buildWeeklyExamples(
      2023, group, new Map(), games, [], presets.ppr, undefined, undefined,
      ruledOut([], 5), rosters,
    );

    expect(examples.find((e) => e.playerId === "backup")!.absenceShare).toBe(0);
  });
});

describe("the recent window around an absence", () => {
  const games = [1, 2, 3, 4, 5, 6].map(game);
  // the starter is hurt after week 3 and comes back in week 6; the
  // backup plays every week, which is what gives DET its calendar
  const rows = [
    ...[1, 2, 3, 6].map((w) => backWeek("starter", w, 12, 3)),
    ...[1, 2, 3, 4, 5, 6].map((w) => backWeek("backup", w, 4, 1)),
  ];
  const at = (week: number, playerId: string) => {
    const examples = buildWeeklyExamples(
      2023, rows, new Map(), games, [], presets.ppr,
    );
    return examples.find((e) => e.week === week && e.playerId === playerId)!;
  };

  it("counts the club weeks a player missed", () => {
    expect(at(6, "starter").gamesMissedRecent).toBe(2);
    expect(at(6, "backup").gamesMissedRecent).toBe(0);
  });

  it("keeps his own form on the games he played", () => {
    // twelve carries and three targets in each of weeks 1 to 3
    expect(at(6, "starter").carriesRecent).toBe(12);
    expect(at(6, "starter").targetsRecent).toBe(3);
  });

  it("counts a week he missed as no share of the group", () => {
    // weeks 2 and 3 at three quarters, weeks 4 and 5 at nothing
    expect(at(6, "starter").backfieldShareRecent).toBeCloseTo(0.375);
    expect(at(6, "backup").backfieldShareRecent).toBeCloseTo(0.625);
  });

  it("measures a ruled-out player's hold on the group over the same weeks", () => {
    const examples = buildWeeklyExamples(
      2023, rows, new Map(), games, [], presets.ppr, undefined, undefined,
      ruledOut(["starter"], 6),
    );
    const backup = examples.find((e) => e.week === 6 && e.playerId === "backup")!;

    // the starter's fifteen touches in two of the four weeks, against
    // the backup's five in all four
    expect(backup.absenceShare).toBeCloseTo(7.5 / 12.5);
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

  it("says it does not know when the player is off the chart", () => {
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

describe("a player his club ruled out this week", () => {
  const games = [1, 2, 3, 4, 5].map(game);
  const rows = [1, 2, 3, 4, 5].flatMap((w) => [
    backWeek("starter", w, 12, 3),
    backWeek("backup", w, 4, 1),
  ]);
  const slate = (report: string) => buildWeeklyExamples(
    2023, rows, new Map(), games, [], presets.ppr, undefined, 5,
    ruledOut(["starter"], 5, report),
  );

  it("stays on the slate with the word his club used", () => {
    const his = slate("Doubtful").find((e) => e.playerId === "starter");

    expect(his).toBeDefined();
    expect(his!.ruledOut).toBe(true);
    expect(his!.status).toBe("Doubtful");
  });

  it("leaves a teammate nobody listed unflagged", () => {
    const his = slate("Out").find((e) => e.playerId === "backup");

    expect(his!.ruledOut).toBe(false);
    expect(his!.status).toBe("");
  });

  it("is still left out of the weeks the model trains on", () => {
    const examples = buildWeeklyExamples(
      2023, rows, new Map(), games, [], presets.ppr, undefined, undefined,
      ruledOut(["starter"], 5, "Doubtful"),
    );

    expect(examples.map((e) => e.playerId)).toEqual(["backup"]);
  });
});
