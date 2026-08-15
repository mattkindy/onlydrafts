import { loadWeeklyRosters, type GameRow } from "../data/nflverse.js";
import { fitRidge, predictRidge } from "../backtest/ridge.js";
import type { SeasonData } from "./seasonModel.js";

const POSITIONS = ["QB", "RB", "WR", "TE"];

export interface RookieExample {
  playerId: string;
  name: string;
  position: string;
  /** overall draft pick; undrafted players get 260 */
  overall: number;
  /** best returning points per game at the same position on his team */
  incumbentPpg: number;
  /** per-game targets plus carries that departed his team at his position */
  vacatedPerGame: number;
  /** age in the rookie season, 22 when the roster omits birth date */
  age: number;
  /** his team's points per game the season before */
  teamPointsPg: number;
  /** rookie-year points per game, once the season has happened */
  actualPpg?: number;
  actualGames: number;
}

export async function rookiesFor(
  season: number,
  data: Map<number, SeasonData>,
  games: GameRow[],
): Promise<RookieExample[]> {
  const roster = await loadWeeklyRosters(season);
  const prev = data.get(season - 1)!.summaries;
  const current = data.get(season)?.summaries;
  const seen = new Set<string>();
  const rookies: RookieExample[] = [];

  const returning = new Set<string>();
  const birthYear = new Map<string, number>();

  for (const appearance of roster) {
    if (appearance.week === 1) {
      returning.add(`${appearance.playerId}|${appearance.teamId}`);
    }

    if (appearance.birthDate) {
      const year = Number(appearance.birthDate.slice(0, 4));

      if (!Number.isNaN(year)) {
        birthYear.set(appearance.playerId, year);
      }
    }
  }

  const incumbents = new Map<string, number>();
  const vacated = new Map<string, number>();

  for (const summary of prev.values()) {
    const key = `${summary.primaryTeamId}|${summary.position}`;

    if (summary.games >= 6) {
      incumbents.set(
        key,
        Math.max(incumbents.get(key) ?? 0, summary.pointsPerGame),
      );
    }

    if (!returning.has(`${summary.playerId}|${summary.primaryTeamId}`)) {
      const opportunity = summary.targetsPerGame + summary.carriesPerGame;
      vacated.set(key, (vacated.get(key) ?? 0) + opportunity);
    }
  }

  const teamPoints = new Map<string, { points: number; games: number }>();

  for (const game of games) {
    if (game.season !== season - 1 || game.homeScore === undefined) {
      continue;
    }

    for (const [team, points] of [
      [game.homeTeamId, game.homeScore],
      [game.awayTeamId, game.awayScore ?? 0],
    ] as [string, number][]) {
      const entry = teamPoints.get(team) ?? { points: 0, games: 0 };
      entry.points += points;
      entry.games++;
      teamPoints.set(team, entry);
    }
  }

  for (const appearance of roster) {
    const position = appearance.rawPosition.toUpperCase();

    if (
      appearance.week !== 1 ||
      appearance.draftYear !== season ||
      !POSITIONS.includes(position) ||
      seen.has(appearance.playerId)
    ) {
      continue;
    }

    seen.add(appearance.playerId);
    const outcome = current?.get(appearance.playerId);

    const team = teamPoints.get(appearance.teamId);

    rookies.push({
      playerId: appearance.playerId,
      name: appearance.name,
      position,
      overall: appearance.draftOverall ?? 260,
      incumbentPpg: incumbents.get(`${appearance.teamId}|${position}`) ?? 0,
      vacatedPerGame: vacated.get(`${appearance.teamId}|${position}`) ?? 0,
      age: birthYear.has(appearance.playerId)
        ? season - birthYear.get(appearance.playerId)!
        : 22,
      teamPointsPg: team && team.games > 0 ? team.points / team.games : 21,
      actualPpg: outcome?.pointsPerGame,
      actualGames: outcome?.games ?? 0,
    });
  }

  return rookies;
}

function row(r: RookieExample): number[] {
  const logPick = Math.log(r.overall);

  return [
    1,
    r.position === "QB" ? 1 : 0,
    r.position === "RB" ? 1 : 0,
    r.position === "TE" ? 1 : 0,
    logPick,
    r.position === "RB" ? logPick : 0,
    r.position === "QB" ? logPick : 0,
    r.vacatedPerGame,
    r.age,
    r.teamPointsPg,
  ];
}

export function fitRookieModel(train: RookieExample[]): number[] {
  const usable = train.filter(
    (r) => r.actualPpg !== undefined && r.actualGames >= 3,
  );

  return fitRidge(usable.map(row), usable.map((r) => r.actualPpg!), 5);
}

export function predictRookie(weights: number[], r: RookieExample): number {
  return Math.max(0, predictRidge(weights, row(r)));
}
