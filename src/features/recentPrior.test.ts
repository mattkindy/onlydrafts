import { describe, expect, it } from "vitest";
import { blankPlayerWeek, type PlayerWeekStats } from "../data/nflverse.js";
import { emptyStatLine, presets } from "../scoring/fantasyPoints.js";
import type { WeeklyExample } from "./weekly.js";
import { buildRecentPriors, shrinkRecentMeans } from "./recentPrior.js";

function prevWeek(
  playerId: string,
  week: number,
  targets: number,
): PlayerWeekStats {
  return {
    playerId,
    playerName: playerId,
    position: "WR",
    season: 2024,
    week,
    teamId: "DET",
    ...blankPlayerWeek(),
    statLine: { ...emptyStatLine(), recYds: 100 },
    targets,
    carries: 0,
    airYards: 0,
  };
}

function example(over: Partial<WeeklyExample> = {}): WeeklyExample {
  return {
    playerId: "steady",
    playerName: "steady",
    position: "WR",
    season: 2025,
    week: 2,
    target: 0,
    targetTargets: 0,
    targetCarries: 0,
    targetReceptions: 0,
    targetRecYds: 0,
    targetRushYds: 0,
    last4: 30,
    gamesBehind: 1,
    targetsRecent: 20,
    carriesRecent: 0,
    gamesMissedRecent: 0,
    targetsExpected: 20,
    carriesExpected: 0,
    airYardsRecent: 0,
    receptionsRecent: 0,
    recYdsRecent: 0,
    rushYdsRecent: 0,
    seasonPpg: 30,
    prevPpg: 10,
    snapRecent: 0.9,
    oppIndex: 1,
    home: true,
    impliedTotal: 21.5,
    spread: 0,
    targetShareRecent: 0,
    backfieldShareRecent: 0,
    passTendency: 0.57,
    staff: { ocChanged: false, hcChanged: false, passShift: 0 },
    questionable: false,
    ruledOut: false,
    status: "",
    limitedPractice: false,
    absenceShare: 0,
    qbAbsenceShare: 0,
    depthRank: 1,
    depthKnown: true,
    teamId: "DET",
    opponent: "KC",
    ...over,
  };
}

/** eight games of ten points and four targets apiece */
const prevSeason = [1, 2, 3, 4, 5, 6, 7, 8].map((w) =>
  prevWeek("steady", w, 4),
);

describe("shrinkRecentMeans", () => {
  const priors = buildRecentPriors(prevSeason, presets.ppr);

  it("splits a one game row evenly with last season at one game of weight", () => {
    const shrunk = shrinkRecentMeans(example(), priors, 1);

    expect(shrunk.targetsRecent).toBeCloseTo((20 + 4) / 2);
    expect(shrunk.last4).toBeCloseTo((30 + 10) / 2);
  });

  it("barely moves a row with four games behind it", () => {
    const shrunk = shrinkRecentMeans(
      example({ gamesBehind: 4 }),
      priors,
      1,
    );

    expect(shrunk.targetsRecent).toBeCloseTo((4 * 20 + 4) / 5);
  });

  it("leaves a row alone when nothing is pulled toward", () => {
    expect(shrinkRecentMeans(example(), priors, 0)).toEqual(example());
  });

  it("falls back to the position mean for a player with no season behind him", () => {
    const shrunk = shrinkRecentMeans(
      example({ playerId: "rookie" }),
      priors,
      1,
    );

    expect(shrunk.targetsRecent).toBeCloseTo((20 + 4) / 2);
  });

  it("gives a player with too few games no prior of his own", () => {
    const short = buildRecentPriors(prevSeason.slice(0, 3), presets.ppr);

    expect(short.byPlayer.size).toBe(0);
    expect(short.byPosition.size).toBe(0);
  });
});
