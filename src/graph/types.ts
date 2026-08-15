/**
 * The graph that everything else queries.
 *
 * Nodes are players, teams, coaches, and games. Edges are stints
 * (player-on-team, coach-on-team) and scheduling (team-in-game). Every
 * stint has a validity span in (season, week) coordinates so features
 * can be computed "as of" a moment. A backtest query for week 3 of 2023
 * must not see a trade that happened in week 8.
 *
 * Weeks use the NFL numbering (1 through 18 for the regular season).
 * A span with an undefined end is still open.
 */

export type Position = "QB" | "RB" | "WR" | "TE" | "K" | "DST";

export type CoachRole = "HC" | "OC" | "DC";

export interface SeasonWeek {
  season: number;
  week: number;
}

export interface Span {
  from: SeasonWeek;
  to?: SeasonWeek;
}

export interface Player {
  id: string;
  name: string;
  position: Position;
  /** NFL draft year and overall pick, when drafted */
  draft?: { season: number; overall: number };
}

export interface Team {
  id: string;
  name: string;
}

export interface Coach {
  id: string;
  name: string;
}

export interface Game {
  id: string;
  season: number;
  week: number;
  homeTeamId: string;
  awayTeamId: string;
}

export interface PlayerStint {
  playerId: string;
  teamId: string;
  span: Span;
}

export interface CoachStint {
  coachId: string;
  teamId: string;
  role: CoachRole;
  span: Span;
}

export interface LeagueGraph {
  players: Map<string, Player>;
  teams: Map<string, Team>;
  coaches: Map<string, Coach>;
  games: Game[];
  playerStints: PlayerStint[];
  coachStints: CoachStint[];
}

export function compareSeasonWeek(a: SeasonWeek, b: SeasonWeek): number {
  if (a.season !== b.season) {
    return a.season - b.season;
  }

  return a.week - b.week;
}

export function spanContains(span: Span, at: SeasonWeek): boolean {
  if (compareSeasonWeek(at, span.from) < 0) {
    return false;
  }

  if (span.to && compareSeasonWeek(at, span.to) > 0) {
    return false;
  }

  return true;
}

/** The team a player belongs to at a moment, or undefined between stints. */
export function teamOf(
  graph: LeagueGraph,
  playerId: string,
  at: SeasonWeek,
): string | undefined {
  return graph.playerStints.find(
    (s) => s.playerId === playerId && spanContains(s.span, at),
  )?.teamId;
}

/** The coach in a given role for a team at a moment. */
export function coachOf(
  graph: LeagueGraph,
  teamId: string,
  role: CoachRole,
  at: SeasonWeek,
): string | undefined {
  return graph.coachStints.find(
    (s) => s.teamId === teamId && s.role === role && spanContains(s.span, at),
  )?.coachId;
}
