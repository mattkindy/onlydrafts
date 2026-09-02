/**
 * How much of a season a man on a list is expected to play.
 *
 * The board prices him off his own injury history and his age, which
 * gives an ordinary man about thirteen or fourteen games. It does not
 * know that this one is on a list today. Josh Jacobs came out at 12.2
 * games while sitting on the not active list, so his draft position
 * from July went on reading like a bargain.
 *
 * Six games is the assumption, since that is roughly what going on
 * injured reserve costs and there is no better number for a man whose
 * return nobody has announced. It is a floor rather than a forecast.
 */

/**
 * The words that mean he is gone for a while rather than a week.
 *
 * NA is not one of them, whatever it looks like. It means no
 * designation, and the men carrying it are Peyton Hillis, Derek Carr
 * and Adam Thielen: retired, or a stale note nobody cleared. Reading it
 * as not active docked six games from anybody with an old flag on him.
 */
export const OUT_FOR_A_WHILE = new Set([
  "IR", "PUP", "Sus", "DNR", "COV", "Out",
]);

/** and how many games that costs him */
export const WEEKS_OUT = 6;

/**
 * His expected games, with the list taken into account. A man already
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
