/**
 * The same plays on both sides of a comparison.
 *
 * A pass pool has sacks in it and nobody is credited with a sack, so
 * comparing what the model draws against the plays a receiver was
 * credited with counts them on one side only. That made every passing
 * down look a yard light and third down look a yard and a half out,
 * and it has been made three separate times in three separate pieces
 * of comparison code.
 *
 * So the rule lives here, and anything comparing the two says which
 * rule it wants rather than filtering by hand.
 */

import type { Call } from "../model/playFactors.js";

/**
 * How far back a pass has to lose before it is taken for a sack.
 *
 * A throwaway loses nothing and a completion behind the line loses a
 * yard or two, so the line goes where only a sack falls.
 */
export const SACK_BEHIND = 2;

export interface RealPlay {
  call: Call;
  yards: number;
  /** who was credited, empty on a sack or a throwaway */
  player: string;
}

/** what a comparison is being made over */
export type Whom =
  /** every snap, sacks and all, which is what a drive is made of */
  | "every play"
  /** only the ones somebody was credited with, which is what a player did */
  | "plays with a man on them";

/** whether this play belongs in a comparison of the given kind */
export function realCounts(play: RealPlay, whom: Whom): boolean {
  if (whom === "every play") {
    return true;
  }

  return play.player !== "";
}

/**
 * And the same question of a drawn gain, which has no name on it.
 *
 * The model is asked about a particular man and hands back yards, so
 * whether it drew a sack can only be told from how far back it went.
 * A pass losing more than a couple of yards is one.
 */
export function drawnCounts(
  call: Call, gained: number, whom: Whom,
): boolean {
  if (whom === "every play") {
    return true;
  }

  return !(call === "pass" && gained < -SACK_BEHIND);
}
