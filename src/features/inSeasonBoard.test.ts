import { describe, expect, it } from "vitest";
import {
  blankPlayerWeek,
  type PlayerWeekStats,
  type SnapCountWeek,
} from "../data/nflverse.js";
import { emptyStatLine } from "../scoring/fantasyPoints.js";
import type { DressedWeek } from "./dressedWeeks.js";
import { roleRowsFrom, weeksFrom } from "./inSeasonBoard.js";

function statRow(over: Partial<PlayerWeekStats> = {}): PlayerWeekStats {
  return {
    playerId: "starter",
    playerName: "A Starter",
    position: "QB",
    season: 2026,
    week: 1,
    teamId: "KC",
    ...blankPlayerWeek(),
    statLine: { ...emptyStatLine(), passYds: 300, passTd: 2 },
    ...over,
  };
}

function dressed(over: Partial<DressedWeek> = {}): DressedWeek {
  return {
    playerId: "backup",
    name: "A Backup",
    teamId: "KC",
    position: "QB",
    week: 1,
    ...over,
  };
}

function snap(over: Partial<SnapCountWeek> = {}): SnapCountWeek {
  return {
    playerName: "A Backup",
    teamId: "KC",
    season: 2026,
    week: 1,
    offensePct: 0.01,
    ...over,
  };
}

describe("weeksFrom", () => {
  it("counts a week a player dressed for and never scored in", () => {
    const read = weeksFrom([statRow()], [snap()], [dressed()]);

    expect(read.weeks.get("backup")).toEqual([{
      week: 1,
      points: 0,
      snapShare: 0.01,
      targets: 0,
      carries: 0,
      airYards: 0,
      passAttempts: 0,
    }]);
  });

  it("gives him no snap share where the snap counts skip him", () => {
    const read = weeksFrom([statRow()], [], [dressed()]);

    expect(read.weeks.get("backup")?.[0]?.snapShare).toBe(0);
  });

  it("names him and files him off the roster, since no stat row does", () => {
    const read = weeksFrom([], [], [dressed({ position: "RB" })]);

    expect(read.byName.get("backup")).toBe("A Backup");
    expect(read.filedAt.get("backup")).toBe("RB");
  });

  it("does not add a second week where he already has a stat row", () => {
    const read = weeksFrom(
      [statRow()],
      [],
      [dressed({ playerId: "starter", name: "A Starter" })],
    );

    expect(read.weeks.get("starter")).toHaveLength(1);
    expect(read.weeks.get("starter")?.[0]?.points).toBeGreaterThan(0);
  });

  it("puts a zero week in its place in the order", () => {
    const read = weeksFrom(
      [statRow({ playerId: "backup", playerName: "A Backup", week: 2 })],
      [],
      [dressed({ week: 3 }), dressed({ week: 1 })],
    );

    expect(read.weeks.get("backup")?.map((w) => w.week)).toEqual([1, 2, 3]);
  });

  it("leaves out a week past the end of the regular season", () => {
    const read = weeksFrom([], [], [dressed({ week: 19 })]);

    expect(read.weeks.get("backup")).toBeUndefined();
  });
});

describe("roleRowsFrom", () => {
  it("trains the role model on a season of dressing and never playing", () => {
    const weeks = [1, 2, 3, 4, 5, 6].map((week) => dressed({ week }));
    const rows = roleRowsFrom(weeksFrom([], [], weeks));

    expect(rows).toEqual([{
      position: "QB",
      usage: {
        snapShare: 0,
        targets: 0,
        carries: 0,
        airYards: 0,
        passAttempts: 0,
      },
      ppg: 0,
    }]);
  });

  it("leaves out a backup dressed for too few games to say anything", () => {
    const weeks = [1, 2, 3].map((week) => dressed({ week }));

    expect(roleRowsFrom(weeksFrom([], [], weeks))).toEqual([]);
  });
});
