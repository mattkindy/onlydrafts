import type { ResidualModel, SeasonNoise } from "../backtest/intervals.js";
import { sampleSeasonBias } from "../backtest/intervals.js";
import type { GameRow } from "../data/nflverse.js";
import { drawWeekOutcomes, type PlayerWeek } from "./season.js";

/** what the season simulator needs to know about one player */
import type { StatParts } from "../features/seasonSummary.js";

export interface SeasonPlayer {
  playerId: string;
  name: string;
  position: string;
  teamId: string;
  /** projected points per game from the season model */
  projectedPpg: number;
  /**
   * And the same projection in yards and catches, which no league has
   * scored yet, so a page can apply its own rules to it.
   */
  projectedParts?: StatParts;
  /**
   * How many games he is expected to be available for, when a model
   * has an opinion about him. The pool says how much a season varies;
   * this says where his own lands, so a back coming back from a knee
   * and one who has never missed a week stop drawing from the same
   * middle.
   */
  expectedGames?: number;
  /** nobody has seen him play, so the board says so */
  rookie?: boolean;
  /** historical games-played outcomes for players like him, sampled per sim */
  gamesPool: number[];
}

export interface SeasonProjection {
  playerId: string;
  name: string;
  position: string;
  /** expected season total across every simulated season */
  meanTotal: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  meanGames: number;
}

/**
 * Simulates every scheduled week for every player at once, so shared
 * game and team shocks correlate teammates the measured amount, then
 * sums to season totals. Availability is an independent weekly coin at
 * each player's rate; injuries have no memory here, which understates
 * long absences and is the known simplification.
 */
/**
 * How many games he plays this time, keeping the pool's shape.
 *
 * The pool is what men like him have done, and it is moved to his own
 * expectation. Scaling the games he plays and then capping at a full
 * season took the cap off the top only, which pulled the average down
 * by more than two games for anyone durable and by nothing at all for
 * anyone fragile, squashing the difference the model exists to find.
 *
 * Scaling the games he misses has no such edge. Missing nothing is
 * already the best case, so shrinking a man's missed games toward zero
 * cannot push him past a full season, and his average comes out where
 * the availability model put it.
 */
function drawGames(
  player: SeasonPlayer, playable: number, rng: () => number,
): number {
  const pool = player.gamesPool;

  if (!pool.length || !player.expectedGames) {
    return Math.min(playable, pool.length
      ? pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))]!
      : playable);
  }

  const season = Math.max(playable, ...pool);
  const drawnMissed = season -
    pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))]!;
  const poolMissed = season -
    pool.reduce((sum, n) => sum + n, 0) / pool.length;
  const hisMissed = Math.max(0, playable - player.expectedGames);
  const missed = poolMissed > 0
    ? drawnMissed * (hisMissed / poolMissed)
    : hisMissed;

  return Math.max(0, Math.min(playable, Math.round(playable - missed)));
}

export function simulatePlayerSeasons(
  players: SeasonPlayer[],
  season: number,
  games: GameRow[],
  residuals: ResidualModel,
  oppAdjust: (position: string, opponent: string) => number,
  catcherLoadingByTeam: Map<string, number>,
  sims: number,
  rng: () => number,
  seasonNoise?: SeasonNoise,
): SeasonProjection[] {
  const schedule = new Map<number, Map<string, { opponent: string; gameKey: string }>>();

  for (const game of games) {
    if (game.season !== season || game.week > 18) {
      continue;
    }

    const weekMap = schedule.get(game.week) ?? new Map();
    const gameKey = `${game.week}|${game.id}`;
    weekMap.set(game.homeTeamId, { opponent: game.awayTeamId, gameKey });
    weekMap.set(game.awayTeamId, { opponent: game.homeTeamId, gameKey });
    schedule.set(game.week, weekMap);
  }

  const totals = new Map<string, number[]>(players.map((p) => [p.playerId, []]));
  const gamesPlayed = new Map<string, number>(players.map((p) => [p.playerId, 0]));

  const weekNumbers = [...schedule.keys()].sort((a, b) => a - b);
  const playableWeeks = new Map<string, number[]>();

  for (const week of weekNumbers) {
    for (const teamId of schedule.get(week)!.keys()) {
      playableWeeks.set(teamId, [...(playableWeeks.get(teamId) ?? []), week]);
    }
  }

  for (let sim = 0; sim < sims; sim++) {
    const seasonTotal = new Map<string, number>();
    const bias = new Map<string, number>();
    const playsThisSim = new Map<string, Set<number>>();

    for (const player of players) {
      if (seasonNoise) {
        bias.set(
          player.playerId,
          sampleSeasonBias(seasonNoise, player.position, rng),
        );
      }

      // the weeks his side is on the field, which is a season less the
      // bye. Drawing from every week instead lost a man his bye week
      // roughly one season in seventeen.
      const his = playableWeeks.get(player.teamId) ?? weekNumbers;
      const target = drawGames(player, his.length, rng);
      const order = [...his];

      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [order[i], order[j]] = [order[j]!, order[i]!];
      }

      playsThisSim.set(player.playerId, new Set(order.slice(0, target)));
    }

    for (const [weekNumber, weekMap] of schedule) {
      const active: PlayerWeek[] = [];

      for (const player of players) {
        const slot = weekMap.get(player.teamId);

        if (!slot || !playsThisSim.get(player.playerId)!.has(weekNumber)) {
          continue;
        }

        gamesPlayed.set(player.playerId, gamesPlayed.get(player.playerId)! + 1);
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

      const outcomes = drawWeekOutcomes(active, residuals, rng, catcherLoadingByTeam);

      for (const [playerId, points] of outcomes) {
        seasonTotal.set(playerId, (seasonTotal.get(playerId) ?? 0) + points);
      }
    }

    for (const player of players) {
      totals.get(player.playerId)!.push(seasonTotal.get(player.playerId) ?? 0);
    }
  }

  return players.map((player) => {
    const list = totals.get(player.playerId)!.sort((a, b) => a - b);
    const q = (p: number) => list[Math.min(list.length - 1, Math.floor(p * list.length))]!;

    return {
      playerId: player.playerId,
      name: player.name,
      position: player.position,
      meanTotal: list.reduce((s, x) => s + x, 0) / list.length,
      p10: q(0.1),
      p25: q(0.25),
      p50: q(0.5),
      p75: q(0.75),
      p90: q(0.9),
      meanGames: gamesPlayed.get(player.playerId)! / sims,
    };
  });
}
