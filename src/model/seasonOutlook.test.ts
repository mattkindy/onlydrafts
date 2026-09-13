import { describe, expect, it } from "vitest";
import {
  DEFAULT_MARGIN_SD,
  homeWinProbability,
  projectSeason,
  TEAM_CODES,
  TEAMS,
  type Fixture,
  type PlayedGame,
  type Ratings,
} from "./seasonOutlook.js";

function flatRatings(): Ratings {
  const out: Ratings = {};

  for (const team of TEAM_CODES) {
    out[team] = 0;
  }

  return out;
}

/** one game against every other team, every team at home once */
function roundRobin(): Fixture[] {
  const out: Fixture[] = [];

  for (let i = 0; i < TEAM_CODES.length; i++) {
    for (let j = i + 1; j < TEAM_CODES.length; j++) {
      const home = i % 2 === 0 ? TEAM_CODES[i]! : TEAM_CODES[j]!;
      const away = i % 2 === 0 ? TEAM_CODES[j]! : TEAM_CODES[i]!;
      out.push({ homeTeam: home, awayTeam: away, neutralSite: false });
    }
  }

  return out;
}

describe("homeWinProbability", () => {
  it("gives a seven point home favourite about three wins in four", () => {
    const edge = 7 + 2;
    const p = homeWinProbability(edge, DEFAULT_MARGIN_SD);
    expect(p).toBeGreaterThan(0.72);
    expect(p).toBeLessThan(0.78);
  });

  it("splits a game between equals on a neutral field", () => {
    expect(homeWinProbability(0, DEFAULT_MARGIN_SD)).toBeCloseTo(0.5, 6);
  });
});

describe("projectSeason", () => {
  it("simulates a seven point home edge to about three wins in four", () => {
    const ratings = flatRatings();
    ratings["BUF"] = 7;
    const remaining: Fixture[] = Array.from({ length: 16 }, () => ({
      homeTeam: "BUF",
      awayTeam: "MIA",
      neutralSite: false,
    }));

    const outlooks = projectSeason({
      ratings,
      homeField: 2,
      marginSd: DEFAULT_MARGIN_SD,
      played: [],
      remaining,
      iterations: 4000,
      seed: 7,
    });
    const buffalo = outlooks.find((outlook) => outlook.team === "BUF")!;
    expect(buffalo.expectedWins / 16).toBeGreaterThan(0.72);
    expect(buffalo.expectedWins / 16).toBeLessThan(0.78);
  });

  it("returns the actual record when every game has been played", () => {
    const played: PlayedGame[] = roundRobin().map((fixture) => ({
      ...fixture,
      homeScore: 24,
      awayScore: 17,
    }));

    const outlooks = projectSeason({
      ratings: flatRatings(),
      homeField: 2,
      marginSd: DEFAULT_MARGIN_SD,
      played,
      remaining: [],
      iterations: 5,
      seed: 3,
    });

    for (const outlook of outlooks) {
      const homeGames = played.filter(
        (game) => game.homeTeam === outlook.team,
      ).length;
      const awayGames = played.filter(
        (game) => game.awayTeam === outlook.team,
      ).length;
      expect(outlook.wins).toBe(homeGames);
      expect(outlook.losses).toBe(awayGames);
      expect(outlook.expectedWins).toBe(homeGames);
      expect(outlook.winLow).toBe(homeGames);
      expect(outlook.winHigh).toBe(homeGames);
    }
  });

  it("hands out four division titles and seven berths per conference", () => {
    const ratings = flatRatings();

    for (let i = 0; i < TEAM_CODES.length; i++) {
      ratings[TEAM_CODES[i]!] = (i % 8) - 4;
    }

    const outlooks = projectSeason({
      ratings,
      homeField: 2,
      marginSd: DEFAULT_MARGIN_SD,
      played: [],
      remaining: roundRobin(),
      iterations: 200,
      seed: 11,
    });

    for (const conference of ["AFC", "NFC"] as const) {
      const group = outlooks.filter(
        (outlook) => TEAMS[outlook.team]!.conference === conference,
      );
      const titles = group.reduce(
        (sum, outlook) => sum + outlook.divisionOdds,
        0,
      );
      const berths = group.reduce(
        (sum, outlook) => sum + outlook.playoffOdds,
        0,
      );
      expect(titles).toBeCloseTo(4, 6);
      expect(berths).toBeCloseTo(7, 6);
    }
  });
});
