import type { GameRow, PlayerWeekStats, SnapCountWeek } from "../data/nflverse.js";
import { normalizeName } from "../data/names.js";
import type { WeeklyAvailability } from "../data/weeklyStatus.js";
import type { RosterAppearance } from "../graph/build.js";
import { fantasyPoints, type ScoringRules } from "../scoring/fantasyPoints.js";
import { buildWeeklyVolume, weeklyVolume } from "./weeklyVolume.js";
import { NO_CHANGE, type StaffChange } from "./staffChange.js";
import {
  clubCalendar,
  clubWeeksMissed,
  recentClubWeeks,
  RECENT_GAMES,
  type ClubCalendar,
} from "./recentWindow.js";

/**
 * One player-week the weekly model predicts. Every feature is computed
 * from weeks strictly before the target week, plus the previous season.
 *
 * Two windows are called recent here, and which one a feature uses
 * matters for a man who missed time. His own form is his last four
 * games played, so a starter back from a month off is read at the level
 * he last played at rather than at zero. Anything measuring a cut of a
 * room is his club's last four game weeks, counting a week he missed as
 * nothing, because the men in the room have to be measured over the
 * same weeks for the shares to add up. Each field below says which one
 * it uses.
 */
export interface WeeklyExample {
  playerId: string;
  playerName: string;
  position: string;
  season: number;
  week: number;
  /** PPR points actually scored in the target week */
  target: number;
  /** stats actually seen in the target week, training labels only */
  targetTargets: number;
  targetCarries: number;
  targetReceptions: number;
  targetRecYds: number;
  targetRushYds: number;
  /** mean points over the last four games he played before this week */
  last4: number;
  /** mean opportunity over the same four games he played */
  targetsRecent: number;
  carriesRecent: number;
  /**
   * club game weeks those four games span beyond the four themselves,
   * which is how many he missed. 0 for a man who has played every week,
   * and 4 for a starter who has been out a month.
   */
  gamesMissedRecent: number;
  /**
   * the same two numbers after the men his club ruled out, put on
   * reserve, or moved off the roster hand their recent work to whoever
   * is left in the room. Equal to the recent averages when nobody is
   * out, and computed over the games he played rather than every row,
   * so a man coming back from a month off is not counted at zero.
   */
  targetsExpected: number;
  carriesExpected: number;
  /** the same four games he played, per game */
  airYardsRecent: number;
  receptionsRecent: number;
  recYdsRecent: number;
  rushYdsRecent: number;
  /** mean points over all games played earlier this season */
  seasonPpg: number;
  /** previous season's points per game, 0 for rookies */
  prevPpg: number;
  /**
   * mean offensive snap share over the last two games he played with
   * snap data. This says how much he plays when he plays, so an absence
   * does not belong in it; gamesMissedRecent says he was gone.
   */
  snapRecent: number;
  /**
   * opponent's points allowed to this position so far this season,
   * relative to the league (1 is average, higher is softer)
   */
  oppIndex: number;
  home: boolean;
  /** Vegas implied points for the player's team, 21.5 when no line exists */
  impliedTotal: number;
  /** points his own team is favored by, negative as an underdog, 0 with no line */
  spread: number;
  /**
   * mean share of his own offence's targets over his club's last four
   * game weeks, counting a week he missed as no share at all.
   */
  targetShareRecent: number;
  /**
   * mean share of the carries and targets his team gave its running
   * backs, over his club's last four game weeks, again counting a week
   * he missed as nothing. 0 for a team-week with no back touches.
   */
  backfieldShareRecent: number;
  /** team's neutral-situation pass rate before this week, 0.57 unknown */
  passTendency: number;
  /** what changed on his club's offensive staff going into this season */
  staff: StaffChange;
  /** his club listed him Questionable on this week's report */
  questionable: boolean;
  /** he was limited in practice this week, or did not practice */
  limitedPractice: boolean;
  /**
   * the cut of his own room's touches over the club's last four game
   * weeks that belongs to teammates his club ruled out this week. The
   * backup of an injured starter sees a number near one.
   */
  absenceShare: number;
  /** the same measure for his club's quarterbacks, 0 for a quarterback */
  qbAbsenceShare: number;
  /** where his club listed him this week, 1 for a starter, 0 unknown */
  depthRank: number;
  /** whether a depth chart covers this season at all */
  depthKnown: boolean;
  teamId: string;
  opponent: string;
}

const POSITIONS = ["QB", "RB", "WR", "TE"];
const FIRST_WEEK = 5;
const MAX_WEEK = 18;

interface TeamWeek {
  opponent: string;
  home: boolean;
  impliedTotal: number;
  spread: number;
}

/** how many points this side is favored by, from spread_line's home view */
function spreadFor(game: GameRow, home: boolean): number {
  if (game.spreadLine === undefined) {
    return 0;
  }

  return home ? game.spreadLine : -game.spreadLine;
}

const DEFAULT_IMPLIED = 21.5;

/**
 * spread_line in the games file is from the home team's side: positive
 * means the home team is favored by that many points.
 */
function impliedFor(game: GameRow, home: boolean): number {
  if (game.totalLine === undefined || game.spreadLine === undefined) {
    return DEFAULT_IMPLIED;
  }

  const half = game.totalLine / 2;
  return home ? half + game.spreadLine / 2 : half - game.spreadLine / 2;
}

export interface Rooms {
  /**
   * the cut of a room's workload over the club's last four game weeks
   * that is owned by men ruled out this week
   */
  shareOut(teamId: string, position: string, week: number): number;
}

/**
 * A man's club and his room come from the last game he played before
 * the week in question, because a man who is out this week has no row
 * of his own to read them from.
 *
 * Every man in the room is averaged over the club's last four game
 * weeks, so a starter who missed two of them counts for half of what he
 * did when healthy and the room's totals add up over the same weeks.
 */
function buildRooms(
  byPlayer: Map<string, PlayerWeekStats[]>,
  availability: WeeklyAvailability | undefined,
  calendar: ClubCalendar,
): Rooms {
  const total = new Map<string, number>();
  const missing = new Map<string, number>();
  const roomKey = (teamId: string, position: string, week: number) =>
    `${teamId}|${position}|${week}`;

  for (const [playerId, rows] of byPlayer) {
    const sorted = [...rows].sort((a, b) => a.week - b.week);

    for (let week = 1; week <= MAX_WEEK; week++) {
      const before = sorted.filter((r) => r.week < week);
      const last = before[before.length - 1];

      if (!last) {
        continue;
      }

      const window = recentClubWeeks(calendar, last.teamId, week);
      const first = window[0];

      if (first === undefined) {
        continue;
      }

      const volume =
        before
          .filter((r) => r.week >= first)
          .reduce((s, r) => s + weeklyVolume(r), 0) / window.length;
      const key = roomKey(last.teamId, last.position, week);
      total.set(key, (total.get(key) ?? 0) + volume);

      if (availability?.status.get(`${playerId}|${week}`)?.out) {
        missing.set(key, (missing.get(key) ?? 0) + volume);
      }
    }
  }

  return {
    shareOut: (teamId, position, week) => {
      const key = roomKey(teamId, position, week);
      const room = total.get(key) ?? 0;

      if (room <= 0) {
        return 0;
      }

      return (missing.get(key) ?? 0) / room;
    },
  };
}

export interface TendencyInputs {
  weekCounts: Map<string, { neutralPlays: number; neutralPasses: number }>;
  priorSeasonRate: Map<string, number>;
  staff?: Map<string, StaffChange>;
}

export function buildWeeklyExamples(
  season: number,
  stats: PlayerWeekStats[],
  prevPpgById: Map<string, number>,
  games: GameRow[],
  snaps: SnapCountWeek[],
  rules: ScoringRules,
  tendencies?: TendencyInputs,
  prospectiveWeek?: number,
  availability?: WeeklyAvailability,
  rosters?: RosterAppearance[],
): WeeklyExample[] {
  const schedule = new Map<string, TeamWeek>();

  for (const game of games) {
    if (game.season !== season) {
      continue;
    }

    schedule.set(`${game.homeTeamId}|${game.week}`, {
      opponent: game.awayTeamId,
      home: true,
      impliedTotal: impliedFor(game, true),
      spread: spreadFor(game, true),
    });
    schedule.set(`${game.awayTeamId}|${game.week}`, {
      opponent: game.homeTeamId,
      home: false,
      impliedTotal: impliedFor(game, false),
      spread: spreadFor(game, false),
    });
  }

  const snapSeries = new Map<string, Map<number, number>>();

  for (const snap of snaps) {
    if (snap.season !== season) {
      continue;
    }

    const key = `${normalizeName(snap.playerName)}|${snap.teamId}`;
    const series = snapSeries.get(key) ?? new Map<number, number>();
    const pct = snap.offensePct > 1.5 ? snap.offensePct / 100 : snap.offensePct;
    series.set(snap.week, pct);
    snapSeries.set(key, series);
  }

  const byPlayer = new Map<string, PlayerWeekStats[]>();

  for (const row of stats) {
    if (!POSITIONS.includes(row.position)) {
      continue;
    }

    const list = byPlayer.get(row.playerId) ?? [];
    list.push(row);
    byPlayer.set(row.playerId, list);
  }

  // every carry and target a team gave its backs in a week, so one back's
  // cut of the room can be read off it
  const backfieldTouches = new Map<string, number>();

  for (const row of stats) {
    if (row.position !== "RB") {
      continue;
    }

    const key = `${row.teamId}|${row.week}`;
    backfieldTouches.set(
      key,
      (backfieldTouches.get(key) ?? 0) + row.carries + row.targets,
    );
  }

  const calendar = clubCalendar([...byPlayer.values()].flat());
  const rooms = buildRooms(byPlayer, availability, calendar);
  const volume = buildWeeklyVolume(byPlayer, availability, rosters);

  // points allowed by each defense to each position, accumulated by week
  const allowed = new Map<string, number[]>();
  const leagueTotal = new Map<string, number[]>();
  const maxWeek = MAX_WEEK;

  const at = (map: Map<string, number[]>, key: string) => {
    const existing = map.get(key);

    if (existing) {
      return existing;
    }

    const created = new Array<number>(maxWeek + 1).fill(0);
    map.set(key, created);
    return created;
  };

  for (const row of stats) {
    if (!POSITIONS.includes(row.position) || row.week > maxWeek) {
      continue;
    }

    const slot = schedule.get(`${row.teamId}|${row.week}`);

    if (!slot) {
      continue;
    }

    const points = fantasyPoints(row.statLine, rules);
    at(allowed, `${slot.opponent}|${row.position}`)[row.week]! += points;
    at(leagueTotal, row.position)[row.week]! += points;
  }

  const cumulativeMean = (series: number[] | undefined, before: number, games: number) => {
    if (!series || before <= 1 || games === 0) {
      return 0;
    }

    let sum = 0;

    for (let w = 1; w < before; w++) {
      sum += series[w] ?? 0;
    }

    return sum / games;
  };

  const tendencyFor = (team: string, before: number): number => {
    if (!tendencies) {
      return 0.57;
    }

    let plays = 0;
    let passes = 0;

    for (let w = 1; w < before; w++) {
      const counts = tendencies.weekCounts.get(`${team}|${season}|${w}`);

      if (counts) {
        plays += counts.neutralPlays;
        passes += counts.neutralPasses;
      }
    }

    if (plays >= 80) {
      return passes / plays;
    }

    return tendencies.priorSeasonRate.get(team) ?? 0.57;
  };

  const assemble = (
    playerId: string,
    rows: PlayerWeekStats[],
    week: number,
    reference: PlayerWeekStats,
    target: PlayerWeekStats | undefined,
  ): WeeklyExample | undefined => {
    const earlier = rows.filter((r) => r.week < week);

    if (earlier.length < 2) {
      return undefined;
    }

    const pointsOf = (r: PlayerWeekStats) => fantasyPoints(r.statLine, rules);
    const recent = earlier.slice(-RECENT_GAMES);
    const lastFour = recent.map(pointsOf);
    const all = earlier.map(pointsOf);
    const meanOf = (pick: (r: PlayerWeekStats) => number) =>
      recent.reduce((s, r) => s + pick(r), 0) / recent.length;

    const backfieldShare = (r: PlayerWeekStats) => {
      const total = backfieldTouches.get(`${r.teamId}|${r.week}`) ?? 0;

      if (total === 0) {
        return 0;
      }

      return (r.carries + r.targets) / total;
    };

    const teamId = reference.teamId;
    const slot = schedule.get(`${teamId}|${week}`);

    if (!slot) {
      return undefined;
    }

    // Everyone in a room has to be measured over the same weeks or their
    // shares do not add up, so a share reads the club's calendar and a
    // week he missed counts as no share at all.
    const clubWindow = recentClubWeeks(calendar, teamId, week);
    const windowStart = clubWindow[0];
    const inWindow =
      windowStart === undefined
        ? []
        : earlier.filter((r) => r.week >= windowStart);
    const clubMeanOf = (pick: (r: PlayerWeekStats) => number) => {
      if (clubWindow.length === 0) {
        return 0;
      }

      return inWindow.reduce((s, r) => s + pick(r), 0) / clubWindow.length;
    };

    const defWeeks = week - 1;
    const defAllowed = cumulativeMean(
      allowed.get(`${slot.opponent}|${reference.position}`),
      week,
      defWeeks,
    );
    const leagueMean =
      cumulativeMean(leagueTotal.get(reference.position), week, defWeeks) / 32;

    const status = availability?.status.get(`${playerId}|${week}`);

    // a man his club ruled out is not on anyone's slate
    if (status?.out) {
      return undefined;
    }

    const depthRank = availability?.depth.rankFor(playerId, week);
    const expected = volume.expectedFor(playerId, week);
    const series = snapSeries.get(
      `${normalizeName(reference.playerName)}|${teamId}`,
    );
    const snapWeeks = earlier
      .map((r) => series?.get(r.week))
      .filter((v): v is number => v !== undefined)
      .slice(-2);

    return {
      playerId,
      playerName: reference.playerName,
      position: reference.position,
      season,
      week,
      target: target ? pointsOf(target) : 0,
      targetTargets: target?.targets ?? 0,
      targetCarries: target?.carries ?? 0,
      targetReceptions: target?.statLine.receptions ?? 0,
      targetRecYds: target?.statLine.recYds ?? 0,
      targetRushYds: target?.statLine.rushYds ?? 0,
      last4: lastFour.reduce((s, x) => s + x, 0) / lastFour.length,
      targetsRecent: meanOf((r) => r.targets),
      carriesRecent: meanOf((r) => r.carries),
      gamesMissedRecent: clubWeeksMissed(
        calendar,
        teamId,
        week,
        recent.map((r) => r.week),
      ),
      targetsExpected: expected.targets,
      carriesExpected: expected.carries,
      airYardsRecent: meanOf((r) => r.airYards),
      receptionsRecent: meanOf((r) => r.statLine.receptions),
      recYdsRecent: meanOf((r) => r.statLine.recYds),
      rushYdsRecent: meanOf((r) => r.statLine.rushYds),
      seasonPpg: all.reduce((s, x) => s + x, 0) / all.length,
      prevPpg: prevPpgById.get(playerId) ?? 0,
      snapRecent:
        snapWeeks.length === 0
          ? 0
          : snapWeeks.reduce((s, x) => s + x, 0) / snapWeeks.length,
      oppIndex: leagueMean > 0 ? defAllowed / leagueMean : 1,
      home: slot.home,
      impliedTotal: slot.impliedTotal,
      spread: slot.spread,
      targetShareRecent: clubMeanOf((r) => r.targetShare),
      backfieldShareRecent:
        reference.position === "RB" ? clubMeanOf(backfieldShare) : 0,
      passTendency: tendencyFor(teamId, week),
      staff: tendencies?.staff?.get(teamId) ?? NO_CHANGE,
      questionable: status?.questionable ?? false,
      limitedPractice: status?.limitedPractice ?? false,
      absenceShare: rooms.shareOut(teamId, reference.position, week),
      qbAbsenceShare:
        reference.position === "QB" ? 0 : rooms.shareOut(teamId, "QB", week),
      depthRank: depthRank ?? 0,
      depthKnown: availability?.depth.covered === true && depthRank !== undefined,
      teamId,
      opponent: slot.opponent,
    };
  };

  const examples: WeeklyExample[] = [];

  for (const [playerId, rows] of byPlayer) {
    rows.sort((a, b) => a.week - b.week);

    for (const row of rows) {
      if (row.week < FIRST_WEEK || row.week > maxWeek) {
        continue;
      }

      const example = assemble(playerId, rows, row.week, row, row);

      if (example) {
        examples.push(example);
      }
    }
  }

  if (prospectiveWeek !== undefined) {
    const prospective: WeeklyExample[] = [];

    for (const [playerId, rows] of byPlayer) {
      rows.sort((a, b) => a.week - b.week);
      const before = rows.filter((r) => r.week < prospectiveWeek);
      const last = before[before.length - 1];

      if (!last) {
        continue;
      }

      const example = assemble(playerId, rows, prospectiveWeek, last, undefined);

      if (example) {
        prospective.push(example);
      }
    }

    return prospective;
  }

  return examples;
}
