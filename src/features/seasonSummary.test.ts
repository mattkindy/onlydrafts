import { describe, expect, it } from "vitest";
import type { PlayerWeekStats } from "../data/nflverse.js";
import { emptyStatLine, presets } from "../scoring/fantasyPoints.js";
import { summarizeSeason } from "./seasonSummary.js";

function week(
  overrides: Partial<PlayerWeekStats> & { week: number },
): PlayerWeekStats {
  return {
    playerId: "p1",
    playerName: "Test Player",
    position: "WR",
    season: 2024,
    teamId: "DET",
    statLine: { ...emptyStatLine(), receptions: 5, recYds: 50 },
    targets: 0,
    carries: 0,
    airYards: 0,
    ...overrides,
  };
}

describe("summarizeSeason", () => {
  it("computes games and points per game", () => {
    const summaries = summarizeSeason([week({ week: 1 }), week({ week: 2 })], presets.ppr);
    const summary = summaries.get("p1");

    expect(summary?.games).toBe(2);
    expect(summary?.pointsPerGame).toBe(10);
  });

  it("picks the team with the most logged weeks as primary", () => {
    const summaries = summarizeSeason(
      [
        week({ week: 1, teamId: "DET" }),
        week({ week: 2, teamId: "KC" }),
        week({ week: 3, teamId: "KC" }),
      ],
      presets.ppr,
    );

    expect(summaries.get("p1")?.primaryTeamId).toBe("KC");
  });
});
