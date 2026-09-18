/**
 * The throws that reach nobody.
 *
 * A sack or a ball thrown away is a pass play that failed with no
 * receiver on it, and it is 26.9% of the pass plays that fail. The
 * walk credited a receiver with every one of them, which is why a busy
 * one was dealt a sixth more targets than he gets.
 *
 * Asked of a throw the walk has already drawn as incomplete, so how
 * often a pass play fails is left where the play pools put it. Counted
 * by the down, the one part of the state it moves with: a failed third
 * down throw was a sack 72.1% of the time against 50.2% on first.
 */

import type { PlayRow } from "./fitPlayFactors.js";

export interface Unaimed {
  /**
   * What became of an incomplete throw on this down, or nothing when a
   * receiver was on it after all.
   */
  reaches: (
    down: number, uniform: () => number,
  ) => { yards: number; sack: boolean } | undefined;
}

/** failed throws needed on a down before it speaks for itself */
const SETTLES_AT = 400;

interface Tally { failed: number; nobody: number; sacks: number }

const blank = (): Tally => ({ failed: 0, nobody: 0, sacks: 0 });

const shrunk = (his: number, of: number, league: number) =>
  (his + SETTLES_AT * league) / (of + SETTLES_AT);

export function fitUnaimed(rows: PlayRow[]): Unaimed {
  const byDown = new Map<number, Tally>();
  const league = blank();
  /** how much a sack cost, to draw one from */
  const lost: number[] = [];

  for (const row of rows) {
    if (row.call !== "pass" || row.caught !== false) {
      continue;
    }

    const his = byDown.get(row.down) ?? blank();
    byDown.set(row.down, his);
    his.failed++;
    league.failed++;

    if (row.player) {
      continue;
    }

    his.nobody++;
    league.nobody++;

    if (row.yards < 0) {
      his.sacks++;
      league.sacks++;
      lost.push(-row.yards);
    }
  }

  const leagueRate = league.failed > 0 ? league.nobody / league.failed : 0.269;
  const leagueSack = league.nobody > 0 ? league.sacks / league.nobody : 0.594;
  const rateOn = new Map<number, number>();
  const sackOn = new Map<number, number>();

  for (const [down, his] of byDown) {
    rateOn.set(down, shrunk(his.nobody, his.failed, leagueRate));
    sackOn.set(down, shrunk(his.sacks, his.nobody, leagueSack));
  }

  return {
    reaches: (down, uniform) => {
      if (uniform() >= (rateOn.get(down) ?? leagueRate)) {
        return undefined;
      }

      if (uniform() >= (sackOn.get(down) ?? leagueSack) || lost.length === 0) {
        return { yards: 0, sack: false };
      }

      return {
        yards: -lost[Math.floor(uniform() * lost.length)]!,
        sack: true,
      };
    },
  };
}
