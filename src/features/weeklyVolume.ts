/**
 * Who is going to get the ball this week, once the men who are out have
 * handed their work to the rest of their room.
 *
 * A man counts as out when his club ruled him Out or Doubtful, when the
 * weekly roster has him as anything but active, or when he is off that
 * team's roster, which is what a trade or a release looks like here.
 *
 * The room's workload over its last four weeks is the budget, and the
 * men available divide it. What a man would do if he plays counts only
 * the games he played, because the weekly file gives an inactive man a
 * row of zeroes, and averaging those in leaves a returning starter
 * stale. That is what makes the two directions come out even.
 */

import type { PlayerWeekStats } from "../data/nflverse.js";
import type { WeeklyAvailability } from "../data/weeklyStatus.js";
import type { RosterAppearance } from "../graph/build.js";
import {
  clubCalendar,
  recentClubWeeks,
  RECENT_GAMES,
  type ClubCalendar,
} from "./recentWindow.js";

const MAX_WEEK = 18;
const ACTIVE_STATUS = "ACT";

/**
 * How much of a room's spare work a man listed at this spot takes,
 * relative to the starter.
 */
function depthWeight(rank: number): number {
  return 1 / rank;
}

/**
 * A room where everybody's recent touches are zero still has to hand
 * the absent man's work to somebody, so nobody weighs exactly nothing.
 */
const TOUCH_FLOOR = 0.25;

/** a quarterback's workload is his throws; everyone else's is his touches */
export function weeklyVolume(row: PlayerWeekStats): number {
  if (row.position === "QB") {
    return row.passing.attempts;
  }

  return row.carries + row.targets;
}

export interface Touches {
  carries: number;
  targets: number;
}

export type TouchKind = keyof Touches;

const KINDS: TouchKind[] = ["carries", "targets"];

export interface WeeklyVolumeModel {
  /** what his room gave him over its last four weeks */
  recentFor(playerId: string, week: number): Touches;
  /** his cut of the room once the men who are out are taken off it */
  expectedFor(playerId: string, week: number): Touches;
  /** whether he is unavailable to the club he last played for */
  isOut(playerId: string, week: number): boolean;
}

interface Standing {
  playerId: string;
  position: string;
  /** the club his recent work was earned with */
  earnedWith: string;
  /** the club he is available to this week, undefined when he is out */
  playingFor: string | undefined;
  /** his last four weeks, counting a week he sat out as nothing */
  current: Touches;
  /**
   * What he asks of the room. His last four weeks say it for a man who
   * has been around all along. A man back from an absence gets the last
   * four games he actually played instead, because the weeks he missed
   * are in the other men's numbers already.
   */
  claim: Touches;
}

function meanTouches(rows: PlayerWeekStats[], over: number): Touches {
  if (over <= 0) {
    return { carries: 0, targets: 0 };
  }

  return {
    carries: rows.reduce((s, r) => s + r.carries, 0) / over,
    targets: rows.reduce((s, r) => s + r.targets, 0) / over,
  };
}

interface RosterView {
  /** the team he was active for that week, undefined when no row says */
  teamFor(playerId: string, week: number): string | undefined;
  /** whether the file lists him anywhere this season */
  known(playerId: string): boolean;
}

function rosterView(rosters: RosterAppearance[] | undefined): RosterView {
  const active = new Map<string, string>();
  const seen = new Set<string>();

  for (const row of rosters ?? []) {
    if (!row.playerId) {
      continue;
    }

    seen.add(row.playerId);

    if (row.status === ACTIVE_STATUS) {
      active.set(`${row.playerId}|${row.week}`, row.teamId);
    }
  }

  return {
    teamFor: (playerId, week) => active.get(`${playerId}|${week}`),
    known: (playerId) => seen.has(playerId),
  };
}

/** how far back an absence still leaves his last four weeks stale */
const RETURN_WINDOW = 2;

function standingsForWeek(
  byPlayer: Map<string, PlayerWeekStats[]>,
  week: number,
  availability: WeeklyAvailability | undefined,
  roster: RosterView,
  wasOut: (playerId: string, week: number) => boolean,
  teamWeeks: ClubCalendar,
): Standing[] {
  const standings: Standing[] = [];

  for (const [playerId, rows] of byPlayer) {
    const before = rows.filter((r) => r.week < week);
    const last = before[before.length - 1];

    if (!last) {
      continue;
    }

    const played = before.filter((r) => weeklyVolume(r) > 0);
    const ruledOut = availability?.status.get(`${playerId}|${week}`)?.out === true;
    const activeWith = roster.teamFor(playerId, week);
    const unlisted = roster.known(playerId) && activeWith === undefined;
    const window = recentClubWeeks(teamWeeks, last.teamId, week);
    const first = window[0] ?? week;
    const current = meanTouches(
      before.filter((r) => r.week >= first),
      window.length,
    );
    const back = Array.from({ length: RETURN_WINDOW }, (_, i) => week - 1 - i).some(
      (earlier) => earlier >= 1 && wasOut(playerId, earlier),
    );

    standings.push({
      playerId,
      position: last.position,
      earnedWith: last.teamId,
      playingFor: ruledOut || unlisted ? undefined : (activeWith ?? last.teamId),
      current,
      claim: back
        ? meanTouches(played.slice(-RECENT_GAMES), Math.min(played.length, RECENT_GAMES))
        : current,
    });
  }

  return standings;
}

function group<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();

  for (const item of items) {
    const list = groups.get(key(item)) ?? [];
    list.push(item);
    groups.set(key(item), list);
  }

  return groups;
}

/**
 * How work nobody is claiming splits among the men left. The club's own
 * chart is the better guide when it exists, because it says who moved
 * up. Without one, the men already getting touches take the rest.
 */
function shareWeights(
  present: Standing[],
  week: number,
  kind: TouchKind,
  rankOf: (playerId: string, week: number) => number | undefined,
): number[] {
  const ranks = present.map((m) => rankOf(m.playerId, week));
  const known = ranks.filter((r): r is number => r !== undefined);
  const touches = present.map((m) => Math.max(m.claim[kind], TOUCH_FLOOR));

  if (known.length === 0) {
    return touches;
  }

  const behind = Math.max(...known) + 1;
  return touches.map((t, i) => t * depthWeight(ranks[i] ?? behind));
}

function shareOut(pool: number, weights: number[]): number[] {
  const total = weights.reduce((s, w) => s + w, 0);

  if (total <= 0) {
    return weights.map(() => 0);
  }

  return weights.map((w) => (pool * w) / total);
}

/**
 * Everyone shrinks in proportion when the men available want more than
 * the room has been giving out, which is what a starter coming back
 * from a month off does to the men who covered for him.
 */
function scaledToBudget(claims: number[], budget: number): number[] {
  const total = claims.reduce((s, c) => s + c, 0);

  if (total <= 0) {
    return claims;
  }

  return claims.map((c) => (c * budget) / total);
}

function divideRoom(
  present: Standing[],
  week: number,
  kind: TouchKind,
  budget: number,
  rankOf: (playerId: string, week: number) => number | undefined,
): number[] {
  const claims = present.map((m) => m.claim[kind]);
  const spare = budget - claims.reduce((s, c) => s + c, 0);

  if (spare <= 0) {
    return scaledToBudget(claims, budget);
  }

  const extra = shareOut(spare, shareWeights(present, week, kind, rankOf));
  return claims.map((c, i) => c + extra[i]!);
}

export function buildWeeklyVolume(
  byPlayer: Map<string, PlayerWeekStats[]>,
  availability?: WeeklyAvailability,
  rosters?: RosterAppearance[],
): WeeklyVolumeModel {
  const roster = rosterView(rosters);
  const rankOf = (playerId: string, week: number) =>
    availability?.depth.covered === true
      ? availability.depth.rankFor(playerId, week)
      : undefined;

  const recent = new Map<string, Touches>();
  const expected = new Map<string, Touches>();
  const out = new Set<string>();
  const at = (playerId: string, week: number) => `${playerId}|${week}`;
  const teamWeeks = clubCalendar([...byPlayer.values()].flat());

  for (let week = 1; week <= MAX_WEEK; week++) {
    const standings = standingsForWeek(
      byPlayer,
      week,
      availability,
      roster,
      (playerId, earlier) => out.has(at(playerId, earlier)),
      teamWeeks,
    );

    for (const man of standings) {
      recent.set(at(man.playerId, week), man.current);
      expected.set(at(man.playerId, week), { ...man.current });

      if (man.playingFor === undefined) {
        out.add(at(man.playerId, week));
      }
    }

    const budgets = group(standings, (m) => `${m.earnedWith}|${m.position}`);
    const rooms = group(
      standings.filter((m) => m.playingFor !== undefined),
      (m) => `${m.playingFor}|${m.position}`,
    );

    for (const [room, present] of rooms) {
      const everyone = budgets.get(room) ?? present;

      for (const kind of KINDS) {
        const budget = everyone.reduce((s, m) => s + m.current[kind], 0);
        const shares = divideRoom(present, week, kind, budget, rankOf);

        present.forEach((man, i) => {
          expected.get(at(man.playerId, week))![kind] = shares[i]!;
        });
      }
    }
  }

  const none: Touches = { carries: 0, targets: 0 };

  return {
    recentFor: (playerId, week) => recent.get(at(playerId, week)) ?? none,
    expectedFor: (playerId, week) => expected.get(at(playerId, week)) ?? none,
    isOut: (playerId, week) => out.has(at(playerId, week)),
  };
}
