/**
 * The sleeper score for the season being played, as of the last week
 * everybody has finished.
 *
 * The bench takes a season apart at weeks 4, 6 and 8 and marks each cut
 * against what the player went on to do. A reader in September wants the
 * same number about this week, with no rest of season to mark it against,
 * so this fits on the seasons behind us and then takes one cut of the
 * season in front of us.
 *
 * A club mid-season still has games to come, which the stat file cannot
 * know because they have not been played, so the weeks the schedule has
 * left are put back before the cut is taken.
 */

import {
  build, cutsFor, boardByName, inSeasonFitFor, playedFor, readSeason,
  SEASONS, type SeasonInput, type SeasonWeeks,
} from "../backtest/sleeperBench.js";
import { loadAdp } from "../data/adp.js";
import { loadPlayerStats, type GameRow } from "../data/nflverse.js";
import { loadLeverage } from "./leverageUsage.js";
import { marketPriceAsOf } from "./marketPrice.js";
import {
  fitSleepersAsOf, scoreSleeper, type SleeperExample, type SleeperScore,
} from "../model/sleepers.js";

/**
 * The first week the score is worth showing. Benched at cuts 2, 3 and 4,
 * the model's top twenty after week 2 hit 38 times against 40 for the
 * price alone, since one or two games leave the points term sorting on
 * noise. After week 3 it hits 46 against the price's 39 and 41 for
 * points a game so far, and it stays ahead from there.
 */
export const FIRST_SLEEPER_WEEK = 3;

export interface SleepersNow {
  /** every scored player, by the id the stat file files him under */
  scores: Map<string, SleeperScore>;
  /** what the season is missing, when nobody could be scored */
  skipped?: string;
}

const nobody = (skipped: string): SleepersNow => ({
  scores: new Map(),
  skipped,
});

/**
 * The weeks each club has left to play, which the stat file has no row
 * for. Without them the cut reads as a club whose season is over and
 * drops every one of its players.
 */
function withGamesToCome(
  read: SeasonWeeks, games: GameRow[], season: number, week: number,
): SeasonWeeks {
  const clubWeeks = new Map(
    [...read.clubWeeks].map(([club, weeks]) => [club, new Set(weeks)]),
  );

  for (const game of games) {
    if (game.season !== season || game.week <= week) {
      continue;
    }

    for (const club of [game.homeTeamId, game.awayTeamId]) {
      const its = clubWeeks.get(club) ?? new Set<number>();

      its.add(game.week);
      clubWeeks.set(club, its);
    }
  }

  return { ...read, clubWeeks };
}

/**
 * Every priced player with a game behind him, scored against his draft
 * price as of `week`. A season with no price curve or nothing counted
 * against it comes back empty with a reason, since a fit that cannot see
 * anybody's work would score the whole board off its price alone.
 */
export async function sleepersNow(
  season: number, week: number, games: GameRow[],
): Promise<SleepersNow> {
  if (week < FIRST_SLEEPER_WEEK) {
    return nobody(
      `only ${week} of the ${FIRST_SLEEPER_WEEK} weeks the score needs ` +
        "have been played out",
    );
  }

  const earlier = SEASONS.filter((one) => one < season);
  const counted = await loadLeverage([season]);
  const lines = counted.get(season) ?? [];

  if (lines.length === 0) {
    return nobody(
      `nothing counted in the leverage file for ${season}, so run ` +
        "scripts/aggregateLeverage.ts",
    );
  }

  const curve = await marketPriceAsOf(season).catch((error: Error) => error);

  if (curve instanceof Error) {
    return nobody(`no price curve for ${season}: ${curve.message}`);
  }

  const built = await build(earlier);
  const examples: SleeperExample[] = built.rows.map((row) => ({
    cut: row.cut,
    restOfSeasonPpg: row.restOfSeasonPpg,
  }));
  const fit = fitSleepersAsOf(season, examples);
  const played = await playedFor([season]);
  const input: SeasonInput = {
    season,
    read: withGamesToCome(
      readSeason(await loadPlayerStats(season)), games, season, week,
    ),
    curve,
    byName: boardByName(await loadAdp(season, "ppr")),
    counted: lines,
    played: played.get(season)!,
    inSeason: inSeasonFitFor(season, played, built.rows),
  };
  const scores = new Map<string, SleeperScore>();

  for (const row of cutsFor(input, week)) {
    scores.set(row.cut.playerId, scoreSleeper(fit, row.cut));
  }

  return { scores };
}
