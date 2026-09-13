/**
 * How much of a season a player on a list is expected to play.
 *
 * The board prices him off his own injury history and his age, which
 * gives an ordinary player about thirteen or fourteen games. It does not
 * know that this one is on a list today. Josh Jacobs came out at 12.2
 * games while sitting on the not active list, so his draft position
 * from July went on reading like a bargain.
 *
 * Six games is the assumption, since that is roughly what going on
 * injured reserve costs and there is no better number for a player whose
 * return nobody has announced. It is a floor rather than a forecast.
 */

/**
 * There are two questions here, and the answer to one is not the answer
 * to the other.
 *
 * One is how much of a season a player will play, which is what the draft
 * board asks. The other is whether he plays on Sunday, which is what an
 * owner setting a lineup asks. The sets below differ on NA, because that
 * word means one thing on a draft board in July and another on a roster
 * in week eight.
 */

/**
 * The words that mean he is gone for a while rather than a week.
 *
 * NA is not one of them, whatever it looks like. It means no
 * designation, and the players carrying it are Peyton Hillis, Derek Carr
 * and Adam Thielen: retired, or a stale note nobody cleared. Reading it
 * as not active docked six games from anybody with an old flag on him.
 */
export const OUT_FOR_A_WHILE = new Set([
  "IR", "PUP", "Sus", "DNR", "COV", "Out",
]);

/**
 * The words that mean he does not play this week.
 *
 * NA is here, unlike in the season set. A player on somebody's roster
 * carrying it is not active, and projecting him a full week was the bug
 * an owner noticed. Questionable and Doubtful are not here, because most
 * of the players carrying either one play, and nothing else in the app marks
 * a doubtful player down.
 */
export const OUT_THIS_WEEK = new Set([
  "IR", "PUP", "Sus", "DNR", "COV", "Out", "NA",
]);

/** whether the injury report says he does not play this week */
export const outThisWeek = (status: string | null | undefined) =>
  Boolean(status && OUT_THIS_WEEK.has(status));

/**
 * The positions a lineup can start. The injury report is read by name,
 * and a linebacker who shares a receiver's name would otherwise rule the
 * receiver out.
 */
export const PLAYED_POSITIONS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

/** whether a listing can be about the player on this row */
export const listingFits = (his: Listed, position: string) =>
  !his.position || his.position === position;

/** what the injury report says about a player, by the board's key for him */
export interface Listed {
  /** his name as the injury report spells it, for a row written from scratch */
  name: string;
  status: string;
  /** where, since a hamstring and a thumb are different news */
  part?: string;
  position?: string;
  team?: string;
}

/** and how many games that costs him */
export const WEEKS_OUT = 6;

/**
 * His expected games, with the list taken into account. A player already
 * marked down below this keeps the lower number, since the board knows
 * something the list does not say.
 */
export function gamesLeft(
  games: number | undefined, status: string | null | undefined,
): number {
  const had = games ?? 17;

  if (!status || !OUT_FOR_A_WHILE.has(status)) {
    return had;
  }

  return Math.min(had, 17 - WEEKS_OUT);
}
