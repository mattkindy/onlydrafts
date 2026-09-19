/**
 * The sleeper claim in the words a reader would use.
 *
 * The board ships the model's own terms, which are what the columns of
 * a ridge fit are called. Nobody drafting on a phone wants to read
 * "points a game so far", so each term gets a short phrase here and the
 * waiver list and the player card both say the same thing.
 */

import type { Sleeper, SleeperReason } from "./scoring.ts";

const PHRASES: Record<string, string> = {
  "work share": "work share",
  "leverage lift": "work when it mattered",
  "trend": "trend",
  "points a game so far": "scoring so far",
  "games played": "games played",
  "pick spread": "the room disagreed",
  "in-season level": "his level so far",
  "role level": "his role",
};

/** how many reasons a row has room for on a phone */
export const REASONS_SHOWN = 2;

/**
 * The terms holding the score up. A term dragging it down is not a
 * reason to add him, so a list of two of those beside a claim of plus
 * two points would read as an argument against itself.
 */
export function reasonsFor(
  said: Sleeper, most = REASONS_SHOWN,
): SleeperReason[] {
  return said.reasons.filter((one) => one.points > 0).slice(0, most);
}

/** the terms as a phrase, or nothing when none of them are helping */
export function reasonWords(said: Sleeper, most = REASONS_SHOWN): string {
  return reasonsFor(said, most)
    .map((one) => PHRASES[one.term] ?? one.term)
    .join(", ");
}

/** the claim itself, as "+2.1 a game over his price" */
export function claimWords(said: Sleeper): string {
  const sign = said.score > 0 ? "+" : "";

  return `${sign}${said.score.toFixed(1)} a game over his price`;
}
