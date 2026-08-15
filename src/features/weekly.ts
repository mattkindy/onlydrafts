import type { GameRow, PlayerWeekStats, SnapCountWeek } from "../data/nflverse.js";
import { normalizeName } from "../data/names.js";
import { fantasyPoints, type ScoringRules } from "../scoring/fantasyPoints.js";

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
  /** mean points over the last four games played before this week */
  last4: number;
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
  teamId: string;
  opponent: string;
}

const POSITIONS = ["QB", "RB", "WR", "TE"];
const FIRST_WEEK = 5;

interface TeamWeek {
  opponent: string;
  home: boolean;
  impliedTotal: number;
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

export function buildWeeklyExamples(
  season: number,
  stats: PlayerWeekStats[],
  prevPpgById: Map<string, number>,
  games: GameRow[],
  snaps: SnapCountWeek[],
  rules: ScoringRules,
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
    });
    schedule.set(`${game.awayTeamId}|${game.week}`, {
      opponent: game.homeTeamId,
      home: false,
      impliedTotal: impliedFor(game, false),
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

  // points allowed by each defense to each position, accumulated by week
  const allowed = new Map<string, number[]>();
  const leagueTotal = new Map<string, number[]>();
  const maxWeek = 18;

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

  const examples: WeeklyExample[] = [];

  for (const [playerId, rows] of byPlayer) {
    rows.sort((a, b) => a.week - b.week);

    for (const row of rows) {
      if (row.week < FIRST_WEEK || row.week > maxWeek) {
        continue;
      }

      const earlier = rows.filter((r) => r.week < row.week);

      if (earlier.length < 2) {
        continue;
      }

      const pointsOf = (r: PlayerWeekStats) => fantasyPoints(r.statLine, rules);
      const lastFour = earlier.slice(-4).map(pointsOf);
      const all = earlier.map(pointsOf);

      const slot = schedule.get(`${row.teamId}|${row.week}`);

      if (!slot) {
        continue;
      }

      const defWeeks = row.week - 1;
      const defAllowed = cumulativeMean(
        allowed.get(`${slot.opponent}|${row.position}`),
        row.week,
        defWeeks,
      );
      const leagueMean =
        cumulativeMean(leagueTotal.get(row.position), row.week, defWeeks) / 32;

      const series = snapSeries.get(
        `${normalizeName(row.playerName)}|${row.teamId}`,
      );
      const snapWeeks = earlier
        .map((r) => series?.get(r.week))
        .filter((v): v is number => v !== undefined)
        .slice(-2);

      examples.push({
        playerId,
        playerName: row.playerName,
        position: row.position,
        season,
        week: row.week,
        target: pointsOf(row),
        last4: lastFour.reduce((s, x) => s + x, 0) / lastFour.length,
        seasonPpg: all.reduce((s, x) => s + x, 0) / all.length,
        prevPpg: prevPpgById.get(playerId) ?? 0,
        snapRecent:
          snapWeeks.length === 0
            ? 0
            : snapWeeks.reduce((s, x) => s + x, 0) / snapWeeks.length,
        oppIndex: leagueMean > 0 ? defAllowed / leagueMean : 1,
        home: slot.home,
        impliedTotal: slot.impliedTotal,
        teamId: row.teamId,
        opponent: slot.opponent,
      });
    }
  }

  return examples;
}
