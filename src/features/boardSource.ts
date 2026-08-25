/**
 * Where the board's numbers come from.
 *
 * There are two answers and the board should not care which. The fitted
 * source predicts each stat with its own regression and spreads a man's
 * season across his weeks with a multiplier. The walked source plays
 * every fixture and adds up what happened, so his attempts and his
 * yards move apart the way they do in a season anybody watched.
 *
 * Both answer the same three questions, so either can be swapped in.
 * See scripts/sourceCompare.ts for which one is winning.
 */

import type { StatParts } from "./seasonSummary.js";

/** one week of his, in the stats a box score counts */
export interface WeekLine {
  week: number;
  opponent: string;
  home: boolean;
  parts: StatParts;
}

export interface SeasonLines {
  /** what he does in a game, averaged over everything the source ran */
  perGame: StatParts;
  /** and each week of his, for a source that plays weeks apart */
  byWeek: WeekLine[];
  /** how many games it had him available for */
  games: number;
}

export interface BoardSource {
  /** what to call it in a log and in the commit that switches it on */
  name: string;
  linesFor: (playerId: string) => SeasonLines | null;
}

const NOTHING: StatParts = {
  passYds: 0, passTd: 0, interceptions: 0, rushYds: 0, rushTd: 0,
  receptions: 0, recYds: 0, recTd: 0,
  passAtt: 0, passCmp: 0, carries: 0, targets: 0,
};

export const noParts = (): StatParts => ({ ...NOTHING });

export const PART_KEYS = Object.keys(NOTHING) as (keyof StatParts)[];

export function addParts(into: StatParts, from: Partial<StatParts>): void {
  for (const part of PART_KEYS) {
    into[part] += from[part] ?? 0;
  }
}

export function scaleParts(parts: StatParts, by: number): StatParts {
  const out = noParts();

  for (const part of PART_KEYS) {
    out[part] = parts[part] * by;
  }

  return out;
}

/**
 * A week as a multiple of what he averages, which is what the board has
 * always shipped and what the page multiplies back out.
 */
export function weeklyShare(
  season: SeasonLines,
  pointsOf: (parts: StatParts) => number,
): { w: number; opp: string; of: number }[] {
  const middle = pointsOf(season.perGame);

  return season.byWeek.map((week) => ({
    w: week.week,
    opp: (week.home ? "v " : "@ ") + week.opponent,
    of: middle > 0
      ? Number((pointsOf(week.parts) / middle).toFixed(3))
      : 1,
  }));
}
