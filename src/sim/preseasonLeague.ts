import type { GameRow } from "../data/nflverse.js";
import type { ResidualModel, SeasonNoise } from "../backtest/intervals.js";
import { sampleSeasonBias } from "../backtest/intervals.js";
import { drawWeekOutcomes, type PlayerWeek } from "./season.js";
import { pickLineup } from "./lineup.js";
import type { SeasonPlayer } from "./playerSeason.js";

export interface LeagueResult {
  /** per team: regular season wins in each simulated season */
  winsPerSim: number[][];
  /** per team: simulated seasons reaching the four-team playoff */
  playoffs: number[];
  /** per team: simulated seasons winning the final */
  titles: number[];
}

function pairings(week: number, teams: number): [number, number][] {
  const rotating = Array.from({ length: teams - 1 }, (_, i) => i + 1);
  const shift = week % (teams - 1);
  const rotated = [...rotating.slice(shift), ...rotating.slice(0, shift)];
  const ring = [0, ...rotated];
  const result: [number, number][] = [];

  for (let i = 0; i < teams / 2; i++) {
    result.push([ring[i]!, ring[teams - 1 - i]!]);
  }

  return result;
}

/**
 * A whole fantasy league simulated from before week 1. Outcomes draw
 * jointly for every rostered player, so byes, injuries, and stack
 * correlations shape the wins; lineups start the highest projected
 * available player each week.
 */
export function simulatePreseasonLeague(
  playersById: Map<string, SeasonPlayer>,
  rosters: string[][],
  season: number,
  games: GameRow[],
  residuals: ResidualModel,
  oppAdjust: (position: string, opponent: string) => number,
  catcherLoading: Map<string, number>,
  seasonNoise: SeasonNoise,
  sims: number,
  rng: () => number,
): LeagueResult {
  const schedule = new Map<number, Map<string, { opponent: string; gameKey: string }>>();

  for (const game of games) {
    if (game.season !== season || game.week > 16) {
      continue;
    }

    const weekMap = schedule.get(game.week) ?? new Map();
    const gameKey = `${game.week}|${game.id}`;
    weekMap.set(game.homeTeamId, { opponent: game.awayTeamId, gameKey });
    weekMap.set(game.awayTeamId, { opponent: game.homeTeamId, gameKey });
    schedule.set(game.week, weekMap);
  }

  const weekNumbers = [...schedule.keys()].sort((a, b) => a - b);
  const rostered = [...new Set(rosters.flat())]
    .map((id) => playersById.get(id))
    .filter((p): p is SeasonPlayer => p !== undefined);
  const winsPerSim: number[][] = rosters.map(() => []);
  const playoffs = rosters.map(() => 0);
  const titles = rosters.map(() => 0);
  const REGULAR_WEEKS = 14;

  for (let sim = 0; sim < sims; sim++) {
    const bias = new Map<string, number>();
    const playsThisSim = new Map<string, Set<number>>();

    for (const player of rostered) {
      bias.set(player.playerId, sampleSeasonBias(seasonNoise, player.position, rng));

      const pool = player.gamesPool;
      const target =
        pool.length === 0
          ? weekNumbers.length
          : Math.min(
              weekNumbers.length,
              pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))]!,
            );
      const order = [...weekNumbers];

      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [order[i], order[j]] = [order[j]!, order[i]!];
      }

      playsThisSim.set(player.playerId, new Set(order.slice(0, target)));
    }

    const wins = rosters.map(() => 0);
    const seasonPoints = rosters.map(() => 0);
    const pointsByWeek = new Map<number, number[]>();

    for (let w = 0; w < weekNumbers.length; w++) {
      const weekNumber = weekNumbers[w]!;
      const weekMap = schedule.get(weekNumber)!;
      const active: PlayerWeek[] = [];

      for (const player of rostered) {
        const slot = weekMap.get(player.teamId);

        if (!slot || !playsThisSim.get(player.playerId)!.has(weekNumber)) {
          continue;
        }

        active.push({
          playerId: player.playerId,
          position: player.position,
          predicted:
            player.projectedPpg * oppAdjust(player.position, slot.opponent) +
            (bias.get(player.playerId) ?? 0),
          teamId: player.teamId,
          gameKey: slot.gameKey,
        });
      }

      const outcomes = drawWeekOutcomes(active, residuals, rng, catcherLoading);
      const activeById = new Map(active.map((p) => [p.playerId, p]));

      const teamPoints = rosters.map((roster) => {
        const candidates = roster
          .map((id) => activeById.get(id))
          .filter((p): p is PlayerWeek => p !== undefined)
          .map((p) => ({
            playerId: p.playerId,
            position: p.position,
            score: playersById.get(p.playerId)!.projectedPpg,
          }));

        let points = 0;

        for (const starter of pickLineup(candidates)) {
          points += outcomes.get(starter) ?? 0;
        }

        return points;
      });

      pointsByWeek.set(weekNumber, teamPoints);

      if (w < REGULAR_WEEKS) {
        for (let team = 0; team < rosters.length; team++) {
          seasonPoints[team]! += teamPoints[team]!;
        }

        for (const [a, b] of pairings(w, rosters.length)) {
          if (teamPoints[a]! > teamPoints[b]!) {
            wins[a]!++;
          } else {
            wins[b]!++;
          }
        }
      }
    }

    for (let team = 0; team < rosters.length; team++) {
      winsPerSim[team]!.push(wins[team]!);
    }

    const seeds = rosters
      .map((_, team) => team)
      .sort(
        (a, b) => wins[b]! - wins[a]! || seasonPoints[b]! - seasonPoints[a]!,
      )
      .slice(0, 4);

    for (const team of seeds) {
      playoffs[team]!++;
    }

    const semiWeek = weekNumbers[REGULAR_WEEKS];
    const finalWeek = weekNumbers[REGULAR_WEEKS + 1];
    const semiPoints = semiWeek !== undefined ? pointsByWeek.get(semiWeek) : undefined;
    const finalPoints = finalWeek !== undefined ? pointsByWeek.get(finalWeek) : undefined;

    if (semiPoints && finalPoints) {
      const winner = (a: number, b: number, points: number[]) =>
        points[a]! >= points[b]! ? a : b;
      const finalistOne = winner(seeds[0]!, seeds[3]!, semiPoints);
      const finalistTwo = winner(seeds[1]!, seeds[2]!, semiPoints);
      titles[winner(finalistOne, finalistTwo, finalPoints)]!++;
    }
  }

  return { winsPerSim, playoffs, titles };
}
