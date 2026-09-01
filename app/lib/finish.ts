/**
 * Where a man could finish among his own position, rather than what he
 * scores in a game.
 *
 * A drafter thinks in finishes. Twelve points a game means nothing on
 * its own; the third best back against the eighteenth best back is the
 * comparison anybody actually makes, and a card of per-game points
 * cannot answer it.
 *
 * His own season quantiles are counted against what everyone else at
 * his position is expected to score. The rest of the position stays
 * still while he moves, so the spread comes out narrower than a season
 * where everybody moves at once.
 */

import type { Player } from "./scoring.ts";

export interface Finish {
  /** his best plausible finish, from the top end of his season */
  best: number;
  mid: number;
  worst: number;
}

/** what a season of his is worth, however the board knows him */
const seasonOf = (p: Player, at: "low" | "ev" | "high"): number | null => {
  if (p.sim && p.sim["ev"]) {
    return p.sim[at] ?? p.sim["ev"] ?? null;
  }

  const rate = p.game?.[at] ?? p.ppg;

  return rate ? rate * (p.games ?? 17) : null;
};

/**
 * Where each of his season's quantiles would place him at his position.
 * Everyone else is taken at their expected season, since what happens
 * when a whole position moves at once needs draws the board does not
 * ship.
 */
export function finishRange(p: Player, men: Player[]): Finish | null {
  const mine = {
    best: seasonOf(p, "high"),
    mid: seasonOf(p, "ev"),
    worst: seasonOf(p, "low"),
  };

  if (mine.mid === null) {
    return null;
  }

  const rivals = men
    .filter((o) => o.position === p.position && o.key !== p.key)
    .map((o) => seasonOf(o, "ev"))
    .filter((n): n is number => n !== null)
    .sort((a, b) => b - a);

  if (rivals.length < 4) {
    return null;
  }

  const placeOf = (score: number | null) => {
    if (score === null) {
      return null;
    }

    let above = 0;

    while (above < rivals.length && rivals[above]! > score) {
      above++;
    }

    return above + 1;
  };

  const mid = placeOf(mine.mid)!;

  return {
    best: placeOf(mine.best) ?? mid,
    mid,
    worst: placeOf(mine.worst) ?? mid,
  };
}
