import type { GameRow, PlayerWeekStats, SnapCountWeek } from "../data/nflverse.js";
import { normalizeName } from "../data/names.js";
import type { WeeklyAvailability } from "../data/weeklyStatus.js";
import type { RosterAppearance } from "../graph/build.js";
import { fantasyPoints, type ScoringRules } from "../scoring/fantasyPoints.js";
import { buildWeeklyVolume, weeklyVolume } from "./weeklyVolume.js";

/**
 * One player-week the weekly model predicts. Every feature is computed
 * from weeks strictly before the target week, plus the previous season.
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
  /** mean points over the last four games played before this week */
  last4: number;
  /** mean opportunity over the same games */
  targetsRecent: number;
  carriesRecent: number;
  /**
   * the same two numbers after the men his club ruled out, put on
   * reserve, or moved off the roster hand their recent work to whoever
   * is left in the room. Equal to the recent averages when nobody is
   * out, and computed over the games he played rather than every row,
   * so a man coming back from a month off is not counted at zero.
   */
  targetsExpected: number;
  carriesExpected: number;
  airYardsRecent: number;
  receptionsRecent: number;
  recYdsRecent: number;
  rushYdsRecent: number;
  /** mean points over all games played earlier this season */
  seasonPpg: number;
  /** previous season's points per game, 0 for rookies */
  prevPpg: number;
  /** mean offensive snap share over the last two games with snap data */
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
  /** mean share of his own offence's targets over the same recent games */
  targetShareRecent: number;
  /**
   * mean share of the carries and targets his team gave its running backs,
   * over the same recent games. 0 for a team-week with no back touches.
   */
  backfieldShareRecent: number;
  /** team's neutral-situation pass rate before this week, 0.57 unknown */
  passTendency: number;
  /** his club listed him Questionable on this week's report */
  questionable: boolean;
  /** he was limited in practice this week, or did not practice */
  limitedPractice: boolean;
  /**
   * the cut of his own room's recent touches that belongs to teammates
   * his club ruled out this week. The backup of an injured starter sees
   * a number near one.
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
const RECENT_GAMES = 4;

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
  /** the cut of a room's recent workload owned by men ruled out this week */
  shareOut(teamId: string, position: string, week: number): number;
}

/**
 * A man's club and his room come from the last game he played before
 * the week in question, because a man who is out this week has no row
 * of his own to read them from.
 */
function buildRooms(
  byPlayer: Map<string, PlayerWeekStats[]>,
  availability: WeeklyAvailability | undefined,
): Rooms {
  const total = new Map<string, number>();
  const missing = new Map<string, number>();
  const roomKey = (teamId: string, position: string, week: number) =>
    `${teamId}|${position}|${week}`;

  for (const [playerId, rows] of byPlayer) {
    const sorted = [...rows].sort((a, b) => a.week - b.week);

    for (let week = 1; week <= MAX_WEEK; week++) {
      const recent = sorted.filter((r) => r.week < week).slice(-RECENT_GAMES);
      const last = recent[recent.length - 1];

      if (!last) {
        continue;
      }

      const volume =
        recent.reduce((s, r) => s + weeklyVolume(r), 0) / recent.length;
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

  const rooms = buildRooms(byPlayer, availability);
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
    const recent = earlier.slice(-4);
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
      targetShareRecent: meanOf((r) => r.targetShare),
      backfieldShareRecent:
        reference.position === "RB" ? meanOf(backfieldShare) : 0,
      passTendency: tendencyFor(teamId, week),
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
