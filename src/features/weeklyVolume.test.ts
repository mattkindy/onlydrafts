import { describe, expect, it } from "vitest";
import { blankPlayerWeek, type PlayerWeekStats } from "../data/nflverse.js";
import { emptyStatLine } from "../scoring/fantasyPoints.js";
import type { WeeklyAvailability, WeekStatus } from "../data/weeklyStatus.js";
import type { RosterAppearance } from "../graph/build.js";
import { buildWeeklyVolume } from "./weeklyVolume.js";

const SEASON = 2024;
const PLAYED_WEEKS = [1, 2, 3, 4];
const TARGET_WEEK = 5;

function back(
  playerId: string,
  teamId: string,
  carries: number,
  weeks = PLAYED_WEEKS,
): PlayerWeekStats[] {
  return weeks.map((week) => ({
    playerId,
    playerName: playerId,
    position: "RB",
    season: SEASON,
    week,
    teamId,
    ...blankPlayerWeek(),
    statLine: emptyStatLine(),
    targets: 2,
    carries,
    airYards: 0,
  }));
}

function roomOf(...men: PlayerWeekStats[][]): Map<string, PlayerWeekStats[]> {
  return new Map(men.map((rows) => [rows[0]!.playerId, rows]));
}

function noDepth(status: Map<string, WeekStatus> = new Map()): WeeklyAvailability {
  return { status, depth: { covered: false, rankFor: () => undefined } };
}

function ruledOut(playerId: string, week: number): Map<string, WeekStatus> {
  return new Map([
    [
      `${playerId}|${week}`,
      { out: true, questionable: false, limitedPractice: false, team: "DET", position: "RB" },
    ],
  ]);
}

function onRoster(
  playerId: string,
  teamId: string,
  week: number,
  status: string,
): RosterAppearance {
  return {
    playerId,
    name: playerId,
    rawPosition: "RB",
    teamId,
    season: SEASON,
    week,
    status,
  };
}

const everyWeek = [...PLAYED_WEEKS, TARGET_WEEK];

describe("buildWeeklyVolume", () => {
  const starter = back("starter", "DET", 20);
  const backup = back("backup", "DET", 4);
  const room = roomOf(starter, backup);

  it("gives the absent starter's carries to the man behind him", () => {
    const rosters = everyWeek.flatMap((week) => [
      onRoster("starter", "DET", week, "ACT"),
      onRoster("backup", "DET", week, "ACT"),
    ]);
    const volume = buildWeeklyVolume(
      room,
      noDepth(ruledOut("starter", TARGET_WEEK)),
      rosters,
    );

    expect(volume.isOut("starter", TARGET_WEEK)).toBe(true);
    expect(volume.recentFor("backup", TARGET_WEEK).carries).toBeCloseTo(4);
    expect(volume.expectedFor("backup", TARGET_WEEK).carries).toBeCloseTo(24);
  });

  it("leaves everyone where he was when nobody is out", () => {
    const volume = buildWeeklyVolume(room, noDepth());

    for (const playerId of ["starter", "backup"]) {
      const recent = volume.recentFor(playerId, TARGET_WEEK);
      const expected = volume.expectedFor(playerId, TARGET_WEEK);

      expect(volume.isOut(playerId, TARGET_WEEK)).toBe(false);
      expect(expected.carries).toBeCloseTo(recent.carries);
      expect(expected.targets).toBeCloseTo(recent.targets);
    }
  });

  it("counts a traded man as gone from the room he left", () => {
    const rosters = [
      ...PLAYED_WEEKS.flatMap((week) => [
        onRoster("starter", "DET", week, "ACT"),
        onRoster("backup", "DET", week, "ACT"),
      ]),
      onRoster("starter", "GB", TARGET_WEEK, "ACT"),
      onRoster("backup", "DET", TARGET_WEEK, "ACT"),
    ];
    const volume = buildWeeklyVolume(room, noDepth(), rosters);

    expect(volume.expectedFor("backup", TARGET_WEEK).carries).toBeCloseTo(24);
  });

  it("counts a man on reserve as out", () => {
    const rosters = [
      ...PLAYED_WEEKS.flatMap((week) => [
        onRoster("starter", "DET", week, "ACT"),
        onRoster("backup", "DET", week, "ACT"),
      ]),
      onRoster("starter", "DET", TARGET_WEEK, "RES"),
      onRoster("backup", "DET", TARGET_WEEK, "ACT"),
    ];
    const volume = buildWeeklyVolume(room, noDepth(), rosters);

    expect(volume.isOut("starter", TARGET_WEEK)).toBe(true);
    expect(volume.expectedFor("backup", TARGET_WEEK).carries).toBeCloseTo(24);
  });

  it("puts a returning starter back on what he did before he sat out", () => {
    const missed = back("starter", "DET", 20, [1, 2]);
    const cover = back("backup", "DET", 4, [1, 2]).concat(
      back("backup", "DET", 18, [3, 4]),
    );
    const rosters = [
      ...[1, 2].map((week) => onRoster("starter", "DET", week, "ACT")),
      ...[3, 4].map((week) => onRoster("starter", "DET", week, "RES")),
      onRoster("starter", "DET", TARGET_WEEK, "ACT"),
      ...everyWeek.map((week) => onRoster("backup", "DET", week, "ACT")),
    ];
    const volume = buildWeeklyVolume(
      roomOf(missed, cover),
      noDepth(),
      rosters,
    );

    const starterNow = volume.expectedFor("starter", TARGET_WEEK).carries;
    const backupNow = volume.expectedFor("backup", TARGET_WEEK).carries;

    // the four-week window has him at 10 because it counts the two he
    // missed, and the room only has so much work to hand out
    expect(volume.recentFor("starter", TARGET_WEEK).carries).toBeCloseTo(10);
    expect(starterNow).toBeGreaterThan(12);
    expect(starterNow).toBeLessThan(20);
    expect(backupNow).toBeLessThan(volume.recentFor("backup", TARGET_WEEK).carries);
  });
});
