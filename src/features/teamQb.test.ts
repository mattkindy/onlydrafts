import { describe, expect, it } from "vitest";
import type { PlayerWeekStats } from "../data/nflverse.js";
import type { RosterAppearance } from "../graph/build.js";
import { emptyStatLine } from "../scoring/fantasyPoints.js";
import type { SeasonSummary } from "./seasonSummary.js";
import { primaryQbByTeam, projectedQbByTeam } from "./teamQb.js";

function qbWeek(playerId: string, teamId: string, week: number): PlayerWeekStats {
  return {
    playerId,
    playerName: playerId,
    position: "QB",
    season: 2023,
    week,
    teamId,
    statLine: emptyStatLine(),
  };
}

describe("primaryQbByTeam", () => {
  it("picks the QB with the most weeks for each team", () => {
    const weeks = [
      qbWeek("starter", "DET", 1),
      qbWeek("starter", "DET", 2),
      qbWeek("backup", "DET", 3),
    ];

    expect(primaryQbByTeam(weeks).get("DET")).toBe("starter");
  });
});

describe("projectedQbByTeam", () => {
  function appearance(playerId: string, week: number): RosterAppearance {
    return {
      playerId,
      name: playerId,
      rawPosition: "QB",
      teamId: "DET",
      season: 2024,
      week,
    };
  }

  function summary(playerId: string, ppg: number): [string, SeasonSummary] {
    return [
      playerId,
      {
        playerId,
        playerName: playerId,
        position: "QB",
        season: 2023,
        games: 10,
        pointsPerGame: ppg,
        tdPointShare: 0,
        primaryTeamId: "DET",
      },
    ];
  }

  it("picks the rostered QB with the best previous season", () => {
    const projected = projectedQbByTeam(
      [appearance("veteran", 1), appearance("backup", 1)],
      new Map([summary("veteran", 18), summary("backup", 4)]),
    );

    expect(projected.get("DET")).toBe("veteran");
  });

  it("ignores roster rows from later weeks", () => {
    const projected = projectedQbByTeam(
      [appearance("veteran", 1), appearance("midseason-signing", 8)],
      new Map([summary("midseason-signing", 20), summary("veteran", 10)]),
    );

    expect(projected.get("DET")).toBe("veteran");
  });
});
