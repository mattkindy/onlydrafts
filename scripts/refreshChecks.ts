/**
 * The counts the refresh check compares against its floors, kept apart
 * from the script so each can be tested on a made-up slate or schedule.
 *
 * Every one of these is a failure that still writes a site that looks
 * normal: a Sleeper fetch that came back empty, a board without the
 * draft room, a forecast service that was down, a slate that lost half
 * its players, or a schedule file too stale to know which week is next.
 */

import type { GameRow } from "../src/data/nflverse.js";
import type { Forecast } from "../src/data/weatherWeekly.js";
import { HOME } from "../src/features/climate.js";

export const SKILL = ["QB", "RB", "WR", "TE"];

/** the share of a slate's skill players Sleeper gave a number, zero included */
export function sleeperShare(
  players: { position: string; sleeper?: number | null }[],
): number {
  const skill = players.filter((p) => SKILL.includes(p.position));

  if (skill.length === 0) {
    return 0;
  }

  const said = skill.filter((p) => p.sleeper !== null && p.sleeper !== undefined);

  return said.length / skill.length;
}

type AdpBy = Record<string, { from?: string } | undefined>;

/** how many players on the board are priced from Sleeper's own drafts */
export function sleeperPriced(players: { adpBy?: AdpBy | null }[]): number {
  return players.filter((p) =>
    Object.values(p.adpBy ?? {}).some((one) => one?.from === "sleeper")).length;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const dayOf = (at: Date) => at.toISOString().slice(0, 10);

/**
 * The week the calendar says is next: the first with a game today or
 * later. The build takes its week from which games have a score, so a
 * schedule file that stopped updating builds a week already played.
 */
export function calendarWeek(
  games: GameRow[], season: number, today: Date,
): number {
  const ofSeason = games.filter((g) => g.season === season);

  if (ofSeason.length === 0) {
    return 1;
  }

  const ahead = ofSeason.filter((g) => g.gameday && g.gameday >= dayOf(today));

  if (ahead.length === 0) {
    return Math.max(...ofSeason.map((g) => g.week));
  }

  return Math.min(...ahead.map((g) => g.week));
}

export interface ForecastCount {
  /** outdoor fixtures close enough for Open-Meteo to forecast */
  due: number;
  /** of those, how many the weather file has a forecast for */
  forecast: number;
}

/**
 * How many of the outdoor fixtures in the next few days have a forecast.
 * The fetch falls back to the ground's climate on any error and still
 * succeeds, so a service that was down shows up only as this count.
 */
export function forecastCount(
  games: GameRow[],
  forecasts: Forecast[],
  season: number,
  today: Date,
  horizonDays: number,
): ForecastCount {
  const from = dayOf(today);
  const until = dayOf(new Date(today.getTime() + horizonDays * DAY_MS));
  const due = games.filter((g) =>
    g.season === season && !g.indoors && g.homeScore === undefined &&
    g.gameday !== undefined && g.gameday >= from && g.gameday <= until &&
    HOME[g.homeTeamId] !== undefined);
  const forecastAt = new Set(
    forecasts
      .filter((f) => f.season === season && f.source === "forecast")
      .map((f) => `${f.week}|${f.homeTeam}`),
  );

  return {
    due: due.length,
    forecast: due.filter((g) => forecastAt.has(`${g.week}|${g.homeTeamId}`))
      .length,
  };
}
