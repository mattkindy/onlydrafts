import { describe, expect, it } from "vitest";
import type { GameRow } from "../src/data/nflverse.js";
import type { Forecast } from "../src/data/weatherWeekly.js";
import {
  calendarWeek, forecastCount, sleeperPriced, sleeperShare,
} from "./refreshChecks.js";

function game(
  week: number, gameday: string, extra: Partial<GameRow> = {},
): GameRow {
  return {
    id: `2026_${week}_${extra.homeTeamId ?? "CHI"}`, season: 2026, week,
    homeTeamId: "CHI", awayTeamId: "GB", indoors: false, divisional: true,
    gameday, ...extra,
  };
}

function forecast(week: number, homeTeam: string, source: Forecast["source"]) {
  return {
    season: 2026, week, homeTeam, wind: 5, temperature: 60, precipitation: 0,
    precipChance: 0, soaked: false, snow: false, source,
  } satisfies Forecast;
}

describe("sleeperShare", () => {
  it("counts a quiet zero as a number and a null as none", () => {
    expect(sleeperShare([
      { position: "QB", sleeper: 18 },
      { position: "RB", sleeper: 0 },
      { position: "WR", sleeper: null },
      { position: "TE" },
      { position: "K", sleeper: null },
      { position: "DEF", sleeper: 7 },
    ])).toBe(0.5);
  });

  it("is zero on a slate with no skill players", () => {
    expect(sleeperShare([{ position: "DEF", sleeper: 7 }])).toBe(0);
  });
});

describe("sleeperPriced", () => {
  it("counts a player priced from Sleeper in any format", () => {
    expect(sleeperPriced([
      { adpBy: { ppr: { from: "sleeper" } } },
      { adpBy: { ppr: { from: "mocks" }, half: { from: "sleeper" } } },
      { adpBy: { ppr: { from: "mocks" } } },
      { adpBy: null },
      {},
    ])).toBe(2);
  });
});

describe("calendarWeek", () => {
  const games = [
    game(2, "2026-09-20"), game(2, "2026-09-21"),
    game(3, "2026-09-24"), game(3, "2026-09-27"),
    game(4, "2026-10-04"),
  ];

  it("is the first week with a game today or later", () => {
    expect(calendarWeek(games, 2026, new Date("2026-09-22T11:00:00Z"))).toBe(3);
    expect(calendarWeek(games, 2026, new Date("2026-09-27T12:00:00Z"))).toBe(3);
    expect(calendarWeek(games, 2026, new Date("2026-09-28T11:00:00Z"))).toBe(4);
  });

  it("is the last week once every game is past", () => {
    expect(calendarWeek(games, 2026, new Date("2027-01-20T11:00:00Z"))).toBe(4);
  });

  it("is week one for a season with no schedule", () => {
    expect(calendarWeek(games, 2027, new Date("2027-08-01T11:00:00Z"))).toBe(1);
  });
});

describe("forecastCount", () => {
  const today = new Date("2026-09-23T11:00:00Z");
  const games = [
    game(3, "2026-09-27", { homeTeamId: "CHI" }),
    game(3, "2026-09-27", { homeTeamId: "BUF" }),
    game(3, "2026-09-27", { homeTeamId: "DET", indoors: true }),
    game(3, "2026-09-21", { homeTeamId: "NYJ", homeScore: 20 }),
    game(6, "2026-10-18", { homeTeamId: "GB" }),
  ];

  it("counts the outdoor games in range and the ones with a forecast", () => {
    expect(forecastCount(games, [
      forecast(3, "CHI", "forecast"),
      forecast(3, "BUF", "climate"),
      forecast(6, "GB", "climate"),
    ], 2026, today, 14)).toEqual({ due: 2, forecast: 1 });
  });

  it("finds nothing due in a week with every game indoors or played", () => {
    expect(forecastCount(games.slice(2, 4), [], 2026, today, 14))
      .toEqual({ due: 0, forecast: 0 });
  });
});
