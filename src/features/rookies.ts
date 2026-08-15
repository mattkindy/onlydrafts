import { loadWeeklyRosters } from "../data/nflverse.js";
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
  /** rookie-year points per game, once the season has happened */
  actualPpg?: number;
  actualGames: number;
}

export async function rookiesFor(
  season: number,
  data: Map<number, SeasonData>,
): Promise<RookieExample[]> {
  const roster = await loadWeeklyRosters(season);
  const prev = data.get(season - 1)!.summaries;
  const current = data.get(season)?.summaries;
  const seen = new Set<string>();
  const rookies: RookieExample[] = [];

  const incumbents = new Map<string, number>();

  for (const summary of prev.values()) {
    const key = `${summary.primaryTeamId}|${summary.position}`;

    if (summary.games >= 6) {
      incumbents.set(
        key,
        Math.max(incumbents.get(key) ?? 0, summary.pointsPerGame),
      );
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

    rookies.push({
      playerId: appearance.playerId,
      name: appearance.name,
      position,
      overall: appearance.draftOverall ?? 260,
      incumbentPpg: incumbents.get(`${appearance.teamId}|${position}`) ?? 0,
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
