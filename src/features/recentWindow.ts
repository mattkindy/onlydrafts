/**
 * The weeks each club played, and the last few of them before a given
 * week.
 *
 * A man's rows in the weekly file skip the weeks he missed, so reading
 * four rows back reaches over an absence as though it never happened. A
 * share or a room total read that way mixes weeks he played with weeks
 * he did not, and comes out too high for him and too low for the men
 * who covered. Counting from the club's calendar gives every man in the
 * room the same weeks, and a man who missed one counts as nothing.
 *
 * Everything needing a recent window asks here, so there is one way of
 * counting it.
 */

import type { PlayerWeekStats } from "../data/nflverse.js";

/** how many of a club's games back a recent window reaches */
export const RECENT_GAMES = 4;

/** the weeks a club played, in order */
export type ClubCalendar = Map<string, number[]>;

export function clubCalendar(rows: Iterable<PlayerWeekStats>): ClubCalendar {
  const weeks = new Map<string, Set<number>>();

  for (const row of rows) {
    const seen = weeks.get(row.teamId) ?? new Set<number>();
    seen.add(row.week);
    weeks.set(row.teamId, seen);
  }

  return new Map(
    [...weeks].map(([team, set]) => [team, [...set].sort((a, b) => a - b)]),
  );
}

/** the club's last few game weeks before this one, earliest first */
export function recentClubWeeks(
  calendar: ClubCalendar,
  teamId: string,
  week: number,
  count: number = RECENT_GAMES,
): number[] {
  return (calendar.get(teamId) ?? []).filter((w) => w < week).slice(-count);
}

/**
 * How many club game weeks a man's own last few games span, over and
 * above the games themselves. For a starter who has not played since
 * week 3 this counts every week he has been out.
 */
export function clubWeeksMissed(
  calendar: ClubCalendar,
  teamId: string,
  week: number,
  playedWeeks: number[],
): number {
  const first = playedWeeks[0];

  if (first === undefined) {
    return 0;
  }

  const span = (calendar.get(teamId) ?? []).filter(
    (w) => w >= first && w < week,
  ).length;
  return Math.max(0, span - playedWeeks.length);
}
