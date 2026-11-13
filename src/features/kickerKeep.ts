/**
 * How much of the rest of the season a kicker goes on to kick, from how
 * he has kicked so far.
 *
 * The board used to give every kicker the same 15.3 games out of 17,
 * whatever he had done. A kicker who misses gets cut, and a manager who
 * holds him then gets nothing at all, so his misses cost far more through
 * his job than through his accuracy. Over 2016 to 2025, standing at week
 * 4, 6, 8 or 10, a kicker three or more kicks under what an average
 * kicker makes from the same distances went on to kick 61% of his club's
 * remaining games, against 91% for one within a kick of it.
 *
 * Accuracy is read as makes over expected, every attempt against what
 * every kicker makes from that band, so a kicker sent out from 55 is not
 * marked down for missing from there. The fit is in `kickerMissesEval.ts`.
 */

import { BANDS } from "./kickerFromWalk.js";

/** what everyone makes from each band, the table the walk reads */
const LEAGUE_MAKES = [0.98, 0.97, 0.94, 0.85, 0.68, 0.4];

/** a logistic fit on 1193 kicker cuts over 2016 to 2025 */
const KEEP_BASE = 2.233;
const KEEP_PER_KICK = 0.433;

/** the most a season's makes can count either way, past what was fitted */
const FURTHEST = 6;

/** his field goals made, less what an average kicker makes from there */
export function madeOverExpected(parts: Record<string, number>): number {
  return BANDS.reduce((sum, band, i) => {
    const made = parts[`fgm_${band.name}`] ?? 0;
    const missed = parts[`fgmiss_${band.name}`] ?? 0;

    return sum + made - (made + missed) * LEAGUE_MAKES[i]!;
  }, 0);
}

/**
 * The share of his club's games left that he kicks in. With nothing
 * kicked yet it is 0.90, which is the 15.3 of 17 the board always gave.
 */
export function keepsTheJob(overExpected: number): number {
  const x = Math.max(-FURTHEST, Math.min(FURTHEST, overExpected));

  return 1 / (1 + Math.exp(-(KEEP_BASE + KEEP_PER_KICK * x)));
}
