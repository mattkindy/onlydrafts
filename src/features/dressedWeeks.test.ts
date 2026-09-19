import { describe, expect, it } from "vitest";
import { blankPlayerWeek, type PlayerWeekStats } from "../data/nflverse.js";
import type { RosterAppearance } from "../graph/build.js";
import { clubWeeksPlayed, dressedWeeks } from "./dressedWeeks.js";

function appearance(over: Partial<RosterAppearance> = {}): RosterAppearance {
  return {
    playerId: "backup",
    name: "A Backup",
    rawPosition: "QB",
    teamId: "KC",
    season: 2026,
    week: 1,
    status: "ACT",
    ...over,
  };
}

function statRow(over: Partial<PlayerWeekStats> = {}): PlayerWeekStats {
  return {
    playerId: "starter",
    playerName: "A Starter",
    position: "QB",
    season: 2026,
    week: 1,
    teamId: "KC",
    ...blankPlayerWeek(),
    ...over,
  };
}

describe("clubWeeksPlayed", () => {
  it("says a club played the weeks its players have box scores in", () => {
    const played = clubWeeksPlayed([
      statRow({ week: 1 }),
      statRow({ week: 3, teamId: "BUF" }),
    ]);

    expect(played.has("KC|1")).toBe(true);
    expect(played.has("BUF|3")).toBe(true);
  });

  it("leaves out a week nobody has a box score in", () => {
    expect(clubWeeksPlayed([statRow({ week: 1 })]).has("KC|2")).toBe(false);
  });
});

describe("dressedWeeks", () => {
  const played = new Set(["KC|1"]);
  const nobodyOut = new Set<string>();

  it("counts an active player in a week his club played", () => {
    const found = dressedWeeks({
      rosters: [appearance()],
      played,
      ruledOut: nobodyOut,
    });

    expect(found).toEqual([{
      playerId: "backup",
      name: "A Backup",
      teamId: "KC",
      position: "QB",
      week: 1,
    }]);
  });

  it("leaves out a player who was not active", () => {
    for (const status of ["INA", "DEV", "RES", "CUT", "RET", "EXE"]) {
      expect(dressedWeeks({
        rosters: [appearance({ status })],
        played,
        ruledOut: nobodyOut,
      })).toEqual([]);
    }
  });

  it("leaves out a week his club did not play", () => {
    expect(dressedWeeks({
      rosters: [appearance({ week: 2 })],
      played,
      ruledOut: nobodyOut,
    })).toEqual([]);
  });

  it("leaves out a player his club ruled out", () => {
    expect(dressedWeeks({
      rosters: [appearance()],
      played,
      ruledOut: new Set(["backup|1"]),
    })).toEqual([]);
  });

  it("gives a player traded mid week one row, not two", () => {
    expect(dressedWeeks({
      rosters: [appearance(), appearance()],
      played,
      ruledOut: nobodyOut,
    })).toHaveLength(1);
  });
});
