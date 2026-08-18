/**
 * The quarterback, who until now did not exist in the walk at all.
 *
 * A pass was drawn against the receiver's own yards, so a team
 * changing quarterbacks threw exactly as it had before. That is most
 * of an offence left out.
 *
 * Multiplying the receiver's level by his quarterback's counts the
 * quarterback twice, because the receiver's history already contains
 * whoever was throwing to him. What is missing is the change: this
 * man's yards were made with those quarterbacks and will be made with
 * this one, so his level moves by the difference between them.
 */

import type { PlayRow } from "./fitPlayFactors.js";

export interface Passing {
  /** what a receiver's level should be multiplied by, given who throws now */
  changeFor: (receiver: string, passerNow: string) => number;
  /** each passer against the league, for reporting */
  levelOf: (passer: string) => number;
  knownPassers: number;
}

export interface PassingSettings {
  /** attempts before a passer's own yards are taken at face value */
  steadyAt: number;
  /** how much of the difference between two passers reaches the receiver */
  reaches: number;
  /** how far the change may move a receiver either way */
  most: number;
}

export const PASSING_DEFAULTS: PassingSettings = {
  steadyAt: 400, reaches: 1, most: 0.35,
};

interface Tally {
  plays: number;
  yards: number;
}

const rate = (tally: Tally | undefined, fallback: number) =>
  tally && tally.plays > 0 ? tally.yards / tally.plays : fallback;

/**
 * Passers measured on the throws they made, and receivers on who was
 * making them.
 *
 * A receiver's own quarterbacks are weighted by how often each threw
 * to him, so a man who split a season between two of them carries
 * both.
 */
export function fitPassing(
  rows: PlayRow[], settings: PassingSettings = PASSING_DEFAULTS,
): Passing {
  const byPasser = new Map<string, Tally>();
  const league: Tally = { plays: 0, yards: 0 };
  const threwTo = new Map<string, Map<string, number>>();

  for (const row of rows) {
    if (row.call !== "pass" || !row.passer) {
      continue;
    }

    const own = byPasser.get(row.passer) ?? { plays: 0, yards: 0 };
    own.plays++;
    own.yards += row.yards;
    byPasser.set(row.passer, own);
    league.plays++;
    league.yards += row.yards;

    if (row.player) {
      const his = threwTo.get(row.player) ?? new Map<string, number>();
      his.set(row.passer, (his.get(row.passer) ?? 0) + 1);
      threwTo.set(row.player, his);
    }
  }

  const middle = rate(league, 6.5);
  const levelOf = (passer: string) => {
    const own = byPasser.get(passer);

    if (!own || own.plays <= 0) {
      return 1;
    }

    // his own yards on few throws say little, so they are pulled
    // toward the league until he has thrown enough
    const trust = own.plays / (own.plays + settings.steadyAt);
    const his = trust * (own.yards / own.plays) + (1 - trust) * middle;

    return his / Math.max(0.5, middle);
  };

  return {
    knownPassers: byPasser.size,
    levelOf,
    changeFor: (receiver, passerNow) => {
      const his = threwTo.get(receiver);

      if (!his || !passerNow) {
        return 1;
      }

      let throws = 0;
      let was = 0;

      for (const [passer, count] of his) {
        throws += count;
        was += count * levelOf(passer);
      }

      if (throws <= 0 || was <= 0) {
        return 1;
      }

      const moved = levelOf(passerNow) / (was / throws);
      const reached = 1 + (moved - 1) * settings.reaches;

      return Math.max(1 - settings.most, Math.min(1 + settings.most, reached));
    },
  };
}
