/**
 * Weeks a player was there to play and his club played.
 *
 * The weekly stats file has a row only for a player who touched the
 * ball, so a backup who dressed and never came on looks the same in it
 * as a man who is not in the league. Anything reading a season off
 * those rows alone reads him as having played no football rather than
 * as having played for nothing, and leaves his August number where it
 * was.
 *
 * Three things have to line up for a week to count here: his club
 * played a game, the roster file had him active, and his club had not
 * ruled him out.
 */

import {
  loadWeeklyRosters,
  type PlayerWeekStats,
} from "../data/nflverse.js";
import type { RosterAppearance } from "../graph/build.js";
import { loadWeeklyInjuryStatus } from "../data/weeklyStatus.js";

/**
 * The one roster status that means a man could have taken the field.
 *
 * The file spells seven or eight codes a season and the rest are all
 * ways of not being available: DEV is the practice squad, RES a reserve
 * list, INA a player who did not dress, CUT and RET and EXE men who are
 * not with the club at all. Over 2023 to 2026 ACT is about two thirds
 * of every row and no other code describes somebody his club could have
 * used on Sunday.
 */
const ACTIVE = "ACT";

export interface DressedWeek {
  playerId: string;
  name: string;
  teamId: string;
  /** what the roster file files him at, which the weekly stats may not */
  position: string;
  week: number;
}

export interface DressedInput {
  rosters: RosterAppearance[];
  /** `team|week` for every game a club has played */
  played: Set<string>;
  /** `playerId|week` for every man his club ruled Out or Doubtful */
  ruledOut: Set<string>;
}

/** how a week is keyed everywhere a caller matches one up */
export function dressedKey(playerId: string, week: number): string {
  return `${playerId}|${week}`;
}

/**
 * Which clubs have played which weeks, read off the box scores rather
 * than the schedule, because the schedule file gets its scores days
 * after the games and would lose a whole weekend. A bye falls out of
 * this on its own, since nobody has a line in a game nobody played.
 */
export function clubWeeksPlayed(stats: PlayerWeekStats[]): Set<string> {
  const played = new Set<string>();

  for (const row of stats) {
    played.add(`${row.teamId}|${row.week}`);
  }

  return played;
}

export function dressedWeeks(input: DressedInput): DressedWeek[] {
  const found = new Map<string, DressedWeek>();

  for (const row of input.rosters) {
    if (row.status !== ACTIVE) {
      continue;
    }

    if (!input.played.has(`${row.teamId}|${row.week}`)) {
      continue;
    }

    // a man who sat hurt was not a backup his club chose not to use, so
    // his week says nothing about what the job pays
    if (input.ruledOut.has(dressedKey(row.playerId, row.week))) {
      continue;
    }

    found.set(dressedKey(row.playerId, row.week), {
      playerId: row.playerId,
      name: row.name,
      teamId: row.teamId,
      position: row.rawPosition,
      week: row.week,
    });
  }

  return [...found.values()];
}

/** every week a player was available for, read off the season's files */
export async function loadDressedWeeks(
  season: number,
  stats: PlayerWeekStats[],
): Promise<DressedWeek[]> {
  const [rosters, listed] = await Promise.all([
    loadWeeklyRosters(season).catch(() => []),
    loadWeeklyInjuryStatus(season).catch(() => new Map()),
  ]);
  const ruledOut = new Set<string>();

  for (const [key, status] of listed) {
    if (status.out) {
      ruledOut.add(key);
    }
  }

  return dressedWeeks({
    rosters,
    played: clubWeeksPlayed(stats),
    ruledOut,
  });
}
