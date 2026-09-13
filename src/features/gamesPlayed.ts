/**
 * How many games a player is likely to be available for.
 *
 * The board used to answer this with four buckets of last season's
 * games, so every player who played nine got the same eight and a half
 * back. That misses what anyone reading a depth chart can see: a back
 * who took three hundred carries, a receiver who spent November
 * on the injury report, a thirty year old, a player who finished the
 * season hurt and is still recovering.
 *
 * Fitted on the seasons before the one being projected, so nothing
 * here reads the future.
 */

import { fitRidge, predictRidge } from "../backtest/ridge.js";

export interface AvailabilityRow {
  playerId: string;
  season: number;
  position: string;
  /** games played in each of the three seasons before this one */
  gamesPrev: number;
  gamesPrev2?: number;
  gamesPrev3?: number;
  age?: number;
  /** carries and targets a game last season, which is the wear on him */
  touchesPerGame: number;
  weightPounds?: number;
  heightInches?: number;
  /** weeks last season he was listed out or doubtful */
  weeksOut: number;
  /** and weeks he was listed at all, including questionable */
  weeksListed: number;
  /**
   * Whether he was still on the report in the last fortnight he could
   * have played, which is what "coming back from an injury" looks like
   * in a table.
   */
  endedHurt: boolean;
  /** share of his team's home games on turf, which is harder on knees */
  onTurf: number;
  /**
   * Weeks his club left him on injured reserve last season. A missing
   * stat line says he did not play; this says his club had stopped
   * expecting him to, which is a stronger and different thing.
   */
  weeksOnReserve?: number;
  /**
   * Whether his club had him on reserve when this season opened, which
   * a drafter can see in August and which no other signal captures.
   */
  openedOnReserve?: boolean;
  /** what actually happened, absent when projecting */
  played?: number;
}

const GAMES_IN_SEASON = 17;

function availabilityRow(r: AvailabilityRow): number[] {
  const played = (n: number | undefined) => (n === undefined ? 14 : n);

  return [
    1,
    r.gamesPrev / GAMES_IN_SEASON,
    played(r.gamesPrev2) / GAMES_IN_SEASON,
    played(r.gamesPrev3) / GAMES_IN_SEASON,
    r.gamesPrev2 === undefined ? 1 : 0,
    (r.age ?? 26) - 26,
    Math.max(0, (r.age ?? 26) - 29),
    r.position === "RB" ? 1 : 0,
    r.position === "QB" ? 1 : 0,
    r.position === "TE" ? 1 : 0,
    r.touchesPerGame / 20,
    r.position === "RB" ? r.touchesPerGame / 20 : 0,
    // a quarterback's dropbacks run to thirty odd a game where a back's
    // carries run to twenty, so what the number means to him is his own
    r.position === "QB" ? r.touchesPerGame / 20 : 0,
    ((r.weightPounds ?? 210) - 210) / 40,
    r.weeksOut / GAMES_IN_SEASON,
    r.weeksListed / GAMES_IN_SEASON,
    r.endedHurt ? 1 : 0,
    r.onTurf,
    (r.weeksOnReserve ?? 0) / GAMES_IN_SEASON,
    r.openedOnReserve ? 1 : 0,
  ];
}

export function fitAvailability(rows: AvailabilityRow[]): number[] {
  const usable = rows.filter((r) => r.played !== undefined);

  return fitRidge(
    usable.map(availabilityRow),
    usable.map((r) => r.played! / GAMES_IN_SEASON),
    3,
  );
}

/** his expected games, kept inside the seventeen a season has */
export function predictAvailability(
  weights: number[], row: AvailabilityRow,
): number {
  const share = predictRidge(weights, availabilityRow(row));

  return Math.min(GAMES_IN_SEASON, Math.max(1, share * GAMES_IN_SEASON));
}
