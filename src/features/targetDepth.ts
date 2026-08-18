/**
 * How far downfield a man is thrown to, and what happens there.
 *
 * Depth is chosen before the ball is caught and settles both halves of
 * the outcome at once. A checkdown gains nothing a quarter of the time
 * and makes seven when it works; a shot past twenty-five gains nothing
 * two thirds of the time and makes thirty-nine. So a possession
 * receiver and a deep threat need different pools, not the same pool
 * scaled, which no multiplier can do since scaling nothing leaves it.
 *
 * A man's own depth carries to the next season at .877, the steadiest
 * thing measured on a player, so it is worth choosing for him.
 */

import type { Call } from "../model/playFactors.js";

/** the bands a throw is sorted into, low edge first */
export const BANDS = [-99, 0, 5, 10, 15, 25];

export const bandOf = (depth: number): number => {
  for (let i = BANDS.length - 1; i >= 0; i--) {
    if (depth >= BANDS[i]!) {
      return i;
    }
  }

  return 0;
};

export interface DepthRow {
  player: string;
  call: Call;
  /** how far downfield it went, absent on a carry */
  airYards?: number;
}

export interface TargetDepth {
  /** which band this man is thrown into, drawn from how he is used */
  bandFor: (player: string, uniform: () => number) => number;
  /**
   * How much more often than the league this man is thrown into each
   * band, so a situation's own mix can be tilted rather than replaced.
   * A goal line throw is short whoever catches it, and a deep threat
   * there is a deep threat being thrown a short one.
   */
  leaningOf: (player: string) => number[];
  /** how many men we could say anything about */
  knownMen: number;
  /** what the league does, for reporting */
  leagueBands: number[];
}

export interface DepthSettings {
  /** throws before a man's own mix is taken at face value */
  steadyAt: number;
}

export const DEPTH_DEFAULTS: DepthSettings = { steadyAt: 40 };

/**
 * Each man's mix of depths, pulled toward the league until he has been
 * thrown at enough for his own to mean something.
 */
export function fitTargetDepth(
  rows: DepthRow[], settings: DepthSettings = DEPTH_DEFAULTS,
): TargetDepth {
  const byMan = new Map<string, number[]>();
  const league = new Array<number>(BANDS.length).fill(0);
  let thrown = 0;

  for (const row of rows) {
    if (
      row.call !== "pass" || !row.player ||
      row.airYards === undefined || !Number.isFinite(row.airYards)
    ) {
      continue;
    }

    const band = bandOf(row.airYards);
    const his = byMan.get(row.player) ?? new Array<number>(BANDS.length).fill(0);
    his[band]!++;
    byMan.set(row.player, his);
    league[band]!++;
    thrown++;
  }

  const leagueShare = league.map((count) => count / Math.max(1, thrown));
  const mixes = new Map<string, number[]>();

  for (const [player, counts] of byMan) {
    const his = counts.reduce((a, b) => a + b, 0);
    const trust = his / (his + settings.steadyAt);
    mixes.set(
      player,
      counts.map((count, i) =>
        trust * (count / Math.max(1, his)) + (1 - trust) * leagueShare[i]!),
    );
  }

  return {
    knownMen: mixes.size,
    leagueBands: leagueShare,
    leaningOf: (player) => {
      const mix = mixes.get(player);

      if (!mix) {
        return leagueShare.map(() => 1);
      }

      return mix.map((share, i) =>
        leagueShare[i]! > 0.002 ? share / leagueShare[i]! : 1);
    },
    bandFor: (player, uniform) => {
      const mix = mixes.get(player) ?? leagueShare;
      let left = uniform();

      for (let i = 0; i < mix.length; i++) {
        left -= mix[i]!;

        if (left <= 0) {
          return i;
        }
      }

      return mix.length - 1;
    },
  };
}
