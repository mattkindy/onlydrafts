import { describe, expect, it } from "vitest";
import { blankParts } from "./partsModel.js";
import { hasSeasonToRead, type SeasonData } from "./seasonModel.js";
import type { SeasonSummary } from "./seasonSummary.js";

function summary(season: number, games: number): SeasonSummary {
  return {
    playerId: "p1",
    playerName: "Test Player",
    position: "RB",
    season,
    games,
    pointsPerGame: 10,
    tdPointShare: 0.2,
    targetsPerGame: 2,
    carriesPerGame: 10,
    airYardsPerGame: 5,
    earlyPpg: 10,
    latePpg: 10,
    primaryTeamId: "GB",
    perGame: blankParts(),
  };
}

function seasons(played: [number, number][]): Map<number, SeasonData> {
  const data = new Map<number, SeasonData>();

  for (const [season, games] of played) {
    data.set(season, {
      stats: [],
      summaries: new Map([["p1", summary(season, games)]]),
      snapShare: new Map(),
      healthyPpg: new Map(),
      compromised: new Map(),
      clearPpg: new Map(),
      softShadow: new Map(),
    });
  }

  return data;
}

describe("hasSeasonToRead", () => {
  it("reads last season", () => {
    expect(hasSeasonToRead("p1", 2026, seasons([[2025, 16]]))).toBe(true);
  });

  it("reaches back a season for a man who missed all of last year", () => {
    expect(hasSeasonToRead("p1", 2026, seasons([[2024, 16], [2025, 0]])))
      .toBe(true);
  });

  it("will not reach back two seasons", () => {
    expect(hasSeasonToRead("p1", 2026, seasons([[2023, 16]]))).toBe(false);
  });

  it("wants four games before it calls a season readable", () => {
    expect(hasSeasonToRead("p1", 2026, seasons([[2024, 1]]))).toBe(false);
  });

  it("says nothing to read for a man with no seasons at all", () => {
    expect(hasSeasonToRead("p1", 2026, seasons([]))).toBe(false);
  });
});
