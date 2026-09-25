/**
 * Where each game in a week has got to, off Sleeper's scores feed.
 *
 * A Sleeper league scores its players off Sleeper's stats, so reading the
 * clock off Sleeper too keeps the points and the time left in step. The
 * feed is the one Sleeper's own app reads and it is not documented, so
 * every field is checked, and a game missing something the engine needs
 * is left out for ESPN's scoreboard to fill.
 */

import { boardTeamOf } from "./boardKeys.ts";
import {
  clockSeconds, downOf, onTheField, type GameRead, type Where,
} from "./gameRead.ts";
import { askWithin } from "./providers.ts";

/** Sleeper's edge keeps the feed ten seconds, so asking sooner gains nothing */
const SCORES_FOR = 10 * 1000;

type Said = string | number | boolean | null | undefined;

export interface SleeperScoreGame {
  status?: string;
  /** kickoff, in epoch ms */
  start_time?: number;
  metadata?: {
    home_team?: string;
    away_team?: string;
    home_score?: Said;
    away_score?: Said;
    quarter_num?: Said;
    /** "6:37", or null before kickoff */
    time_remaining?: string | null;
    is_overtime?: boolean;
    /** the team with the ball, by code */
    possession?: string | null;
    yard_line?: Said;
    /** whose half the ball is in, by code */
    yard_line_territory?: string | null;
    down?: Said;
    /** "2nd & 8", or "1st & Goal" */
    down_and_distance?: string | null;
    home_used_timeouts?: Said;
    away_used_timeouts?: Said;
  };
}

const WHERE: Record<string, Where> = {
  pre_game: "pre", in_game: "in", complete: "post",
};

/** a number Sleeper sent as one, or wrote out as one */
function numberIn(said: Said): number | undefined {
  if (typeof said === "number") {
    return Number.isFinite(said) ? said : undefined;
  }

  if (typeof said !== "string" || said.trim() === "") {
    return undefined;
  }

  const n = Number(said);

  return Number.isFinite(n) ? n : undefined;
}

const TIMEOUTS_A_HALF = 3;

const timeoutsLeft = (used: Said) =>
  Math.min(TIMEOUTS_A_HALF, Math.max(0, TIMEOUTS_A_HALF - (numberIn(used) ?? 0)));

/**
 * Yards to the goal the team with the ball is going for. Sleeper gives
 * the yard line and whose half it is in, so the ball at its own 47 is 53
 * yards out and at the other side's 47 is 47.
 */
function yardsToGo(
  yardLine: number | undefined, territory: string | null | undefined,
  withBall: string,
): number | undefined {
  if (yardLine === undefined) {
    return undefined;
  }

  if (!territory) {
    return yardLine === 50 ? 50 : undefined;
  }

  return onTheField(
    boardTeamOf(territory) === withBall ? 100 - yardLine : yardLine);
}

/** "2nd & 8" is eight to go, and "1st & Goal" is as far as the goal line */
function toGoIn(said: string | null | undefined, yardline: number | undefined) {
  const read = /&\s*(\d+|goal)/i.exec(said ?? "");

  if (!read) {
    return undefined;
  }

  return /goal/i.test(read[1]!) ? yardline : Number(read[1]);
}

type Meta = NonNullable<SleeperScoreGame["metadata"]>;

type Ball = Pick<GameRead, "withBall" | "yardline" | "down" | "toGo">;

/** the ball, where the feed says which side has it and where */
function ballOf(meta: Meta, home: string, away: string): Ball {
  const code = meta.possession ? boardTeamOf(meta.possession) : undefined;

  if (!code || (code !== home && code !== away)) {
    return {};
  }

  const yardline = yardsToGo(
    numberIn(meta.yard_line), meta.yard_line_territory, code);
  const down = downOf(numberIn(meta.down));
  const toGo = down === undefined
    ? undefined
    : toGoIn(meta.down_and_distance, yardline);

  return {
    withBall: code,
    ...(yardline !== undefined ? { yardline } : {}),
    ...(down !== undefined ? { down } : {}),
    ...(toGo !== undefined ? { toGo } : {}),
  };
}

/**
 * The clock of a game that is on, or null when the feed has not said
 * which quarter or how long is left in it.
 */
function clockOf(meta: Meta) {
  const quarter = numberIn(meta.quarter_num);
  const seconds = clockSeconds(meta.time_remaining);

  if (quarter === undefined || quarter < 1 || seconds === null) {
    return null;
  }

  return {
    period: meta.is_overtime === true ? Math.max(5, quarter) : quarter,
    clock: seconds,
  };
}

/** one game off Sleeper's feed, or null when it lacks what the engine needs */
export function sleeperGameOf(game: SleeperScoreGame): GameRead | null {
  const where = WHERE[game.status ?? ""];
  const meta = game.metadata;

  if (!where || !meta?.home_team || !meta.away_team) {
    return null;
  }

  const home = boardTeamOf(meta.home_team);
  const away = boardTeamOf(meta.away_team);
  const bare: GameRead = {
    where,
    home,
    away,
    points: {
      [home]: numberIn(meta.home_score) ?? 0,
      [away]: numberIn(meta.away_score) ?? 0,
    },
    ...(typeof game.start_time === "number"
      ? { kickoff: game.start_time }
      : {}),
    period: 1,
    clock: 0,
    timeouts: {
      [home]: timeoutsLeft(meta.home_used_timeouts),
      [away]: timeoutsLeft(meta.away_used_timeouts),
    },
    redZone: false,
  };

  if (where !== "in") {
    return bare;
  }

  const clock = clockOf(meta);

  if (!clock) {
    return null;
  }

  const ball = ballOf(meta, home, away);

  return {
    ...bare,
    ...clock,
    ...ball,
    // the feed's own red zone field is a string with no documented values,
    // so the yard line decides
    redZone: ball.yardline !== undefined && ball.yardline <= 20,
  };
}

/** every game Sleeper's feed could describe, leaving out those it could not */
export const sleeperGamesFrom = (said: unknown): GameRead[] =>
  (Array.isArray(said) ? said as SleeperScoreGame[] : [])
    .map(sleeperGameOf)
    .filter((game): game is GameRead => game !== null);

/** the week's games off Sleeper, which throws when the feed will not answer */
export async function sleeperGames(
  season: number, week: number,
): Promise<GameRead[]> {
  const said = await askWithin(
    "/scores/nfl/regular/" + season + "/" + week, SCORES_FOR);

  if (!Array.isArray(said)) {
    throw new Error("Sleeper's scores came back as something other than a list");
  }

  return sleeperGamesFrom(said);
}
