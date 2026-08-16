/**
 * How many passes and hand-offs an offence gets before its players
 * divide them up. Vegas knows more about this than we do, so start
 * from the team's own habit and let the line move it.
 *
 * Measured over 2021 to 2025, 2716 team-games: a big underdog throws
 * on 56% of its plays and a big favourite on 52%, which is five more
 * hand-offs a game for the favourite's back. A game expected to reach
 * the high forties adds four pass attempts over one in the thirties.
 * Wind above 15mph outdoors takes two and a half attempts away.
 */

import type { GameRow } from "../data/nflverse.js";
import type { TeamWeek } from "./playerWeek.js";

/** the average team's split, for anchoring the adjustments */
const LEAGUE_PASS_SHARE = 0.542;
const LEAGUE_PLAYS = 58.6;
const LEAGUE_TOTAL = 45;

/** pass share per point of spread, from the buckets above */
const PER_SPREAD_POINT = 0.0021;
/** pass share per point the game total sits above average */
const PER_TOTAL_POINT = 0.0058;
/** plays per point the game total sits above average */
const PLAYS_PER_TOTAL_POINT = 0.24;
/** pass share lost per mph of wind past the point it starts to bite */
const WIND_THRESHOLD = 8;
const PER_WIND_MPH = 0.0025;

export interface TeamHabit {
  /** the team's own pass share, before the game's own circumstances */
  passShare: number;
  /** plays a game it usually runs */
  plays: number;
}

/**
 * `favouredBy` is from this team's side, so a 7 point favourite passes
 * `7`, and its opponent passes `-7`.
 */
export function teamWeekFrom(
  habit: TeamHabit,
  game: Pick<GameRow, "totalLine" | "wind" | "indoors">,
  favouredBy: number,
  impliedTotal: number,
): TeamWeek {
  const total = game.totalLine ?? LEAGUE_TOTAL;
  const wind = game.indoors ? 0 : Math.max(0, (game.wind ?? 0) - WIND_THRESHOLD);
  const passShare = Math.min(
    0.75,
    Math.max(
      0.35,
      habit.passShare
        - favouredBy * PER_SPREAD_POINT
        + (total - LEAGUE_TOTAL) * PER_TOTAL_POINT
        - wind * PER_WIND_MPH,
    ),
  );
  // a game expected to score keeps both offences on the field longer
  const plays = Math.max(
    40,
    habit.plays + (total - LEAGUE_TOTAL) * PLAYS_PER_TOTAL_POINT,
  );

  return {
    passAttempts: plays * passShare,
    rushAttempts: plays * (1 - passShare),
    impliedTotal,
  };
}

export const LEAGUE_HABIT: TeamHabit = {
  passShare: LEAGUE_PASS_SHARE,
  plays: LEAGUE_PLAYS,
};
