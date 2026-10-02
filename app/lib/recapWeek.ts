/**
 * The week the league tab's recap falls back on.
 *
 * The app opens on the newest built week, and the refresh builds the
 * coming week every morning from Tuesday, so for most of the week none of
 * the league's games on screen are over and there is nothing to recap.
 * The tab then recaps the week before, read here in one go: the league's
 * games, where each NFL game ended, the slate and every player's points.
 * Those games are over, so the read is made once and never polled.
 */

import type { GameState, WeekGames } from "./matchups.ts";
import type { Matchup, PlayerWeek } from "./providers.ts";
import type { Slate, SlateRow, WeekRef } from "./slate.ts";

export interface RecapWeek {
  season: number;
  week: number;
  games: Matchup[];
  rows: Map<string, SlateRow>;
  states: Map<string, GameState>;
  /** every player's week, left out when the provider would not say */
  weeks?: PlayerWeek[];
}

/** the reads a recap week needs, which a test can stand in for */
export interface RecapReads {
  matchupsFor: (week: number) => Promise<Matchup[]>;
  readGames: (season: number, week: number) => Promise<Pick<WeekGames, "states">>;
  loadSlate: (file: string) => Promise<Slate>;
  rowsOf: (slate: Slate) => Map<string, SlateRow>;
  weekPointsFor?: ((week: number) => Promise<PlayerWeek[]>) | undefined;
}

/**
 * The newest built week before the one shown, in the same season. A
 * league's games from another season belong to another league.
 */
export function weekBefore(weeks: WeekRef[], shown: WeekRef): WeekRef | null {
  const before = weeks.filter(
    (ref) => ref.season === shown.season && ref.week < shown.week);

  return before[before.length - 1] ?? null;
}

export async function readRecapWeek(
  ref: WeekRef, reads: RecapReads,
): Promise<RecapWeek> {
  const [games, read, slate, weeks] = await Promise.all([
    reads.matchupsFor(ref.week),
    reads.readGames(ref.season, ref.week),
    reads.loadSlate(ref.file),
    // the recap reads better without the free agents than not at all
    reads.weekPointsFor?.(ref.week).catch(() => undefined),
  ]);

  return {
    season: ref.season,
    week: ref.week,
    games,
    rows: reads.rowsOf(slate),
    states: read.states,
    ...(weeks ? { weeks } : {}),
  };
}
