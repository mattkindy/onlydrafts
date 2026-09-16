import { describe, expect, it } from "vitest";
import { blankParts } from "./partsModel.js";
import {
  fitSeasonModel,
  hasSeasonToRead,
  predictSeasonBlend,
  type SeasonData,
  type SeasonExample,
} from "./seasonModel.js";
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

  it("reaches back a season for a player who missed all of last year", () => {
    expect(hasSeasonToRead("p1", 2026, seasons([[2024, 16], [2025, 0]])))
      .toBe(true);
  });

  it("will not reach back two seasons", () => {
    expect(hasSeasonToRead("p1", 2026, seasons([[2023, 16]]))).toBe(false);
  });

  it("wants four games before it calls a season readable", () => {
    expect(hasSeasonToRead("p1", 2026, seasons([[2024, 1]]))).toBe(false);
  });

  it("says nothing to read for a player with no seasons at all", () => {
    expect(hasSeasonToRead("p1", 2026, seasons([]))).toBe(false);
  });
});

function player(
  playerId: string,
  snapPct: number,
  gamesPrev: number,
  prevPpg: number,
  actualPpg: number,
): SeasonExample {
  return {
    playerId,
    position: "WR",
    prevPpg,
    actualPpg,
    moved: false,
    group: "skill-stayer-same-qb",
    rookieCapital: 0,
    snapPct,
    gamesPrev,
    tdPointShare: 0.2,
    olRetention: 0.8,
    ocChanged: false,
    hcChanged: false,
    ocReunion: false,
    targetsPerGame: 12 * snapPct,
    carriesPerGame: 0,
    airYardsPerGame: 90 * snapPct,
    earlyPpg: prevPpg,
    latePpg: prevPpg,
    compromised: 0,
    softShadow: 0,
    ownCapital: 0.5,
    rivalPpg: 8,
    rivalCapital: 0.5,
    ownShare: 0.4,
    passShift: 0,
  };
}

/**
 * Receivers whose level is set by their snap share, measured over a
 * season of varying length, so a short season is a noisy read of a
 * level the next season repeats.
 */
function noisySeasons(): SeasonExample[] {
  const examples: SeasonExample[] = [];
  let seed = 7;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;

    return seed / 2147483648;
  };

  for (let i = 0; i < 400; i++) {
    const snapPct = 0.1 + 0.85 * next();
    const games = 6 + Math.floor(12 * next());
    const level = 20 * snapPct;
    const noise = (next() - 0.5) * 40 / Math.sqrt(games);
    examples.push(
      player(`p${i}`, snapPct, games, Math.max(0.5, level + noise),
        Math.max(0.5, level + (next() - 0.5) * 4)),
    );
  }

  return examples;
}

describe("the season baseline", () => {
  const fit = fitSeasonModel(noisySeasons());

  it("trusts a full season more than a short one", () => {
    const short = predictSeasonBlend(fit, player("short", 0.4, 6, 18, 0));
    const full = predictSeasonBlend(fit, player("full", 0.4, 17, 18, 0));

    expect(short).toBeLessThan(full);
  });

  it("reads the snap share a player's scoring came off", () => {
    const parttime = predictSeasonBlend(fit, player("part", 0.3, 8, 12, 0));
    const starter = predictSeasonBlend(fit, player("start", 0.9, 8, 12, 0));

    expect(parttime).toBeLessThan(starter);
  });
});
