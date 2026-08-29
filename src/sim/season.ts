import type { ResidualModel } from "../backtest/intervals.js";
import { outcomeQuantile } from "../backtest/intervals.js";
import { normalCdf, normalDraw } from "./normal.js";
import { pickLineup, type LineupCandidate } from "./lineup.js";

/** what the simulator knows about one rostered player in one week */
export interface PlayerWeek {
  playerId: string;
  position: string;
  predicted: number;
  teamId: string;
  /** same string for both sides of one NFL game */
  gameKey: string;
  /**
   * His own week distribution as a quantile, when one engine has dealt
   * him enough games to have one. Without it the pooled residual bands
   * for his position and level speak instead.
   */
  own?: (q: number) => number;
}

/** playerId -> a fixed preseason value, for the naive policy */
export type StaticValues = Map<string, number>;

export type PolicyName = "hindsight" | "model" | "naive";

export interface SeasonResult {
  /** mean weekly starter points per policy */
  meanPoints: Record<PolicyName, number>;
}

/**
 * Correlation loadings measured by scripts/estimateCorrelation.ts on
 * 2016 to 2023 residuals: opponents 0.028, QB with his catchers 0.232.
 * GAME loads everyone; catchers also load on their QB's own shock.
 * Known approximation: catcher pairs on one team come out near 0.07
 * where the data says 0, since shared factors cannot express the
 * target competition that cancels the QB channel between them.
 */
const GAME_LOADING = Math.sqrt(0.028);
const QB_TO_CATCHER = 0.207;

const CATCHERS = new Set(["WR", "TE"]);

/**
 * Draws one correlated outcome per player. Every player shares the
 * game factor; a catcher's draw mixes in the QB-team shock so stacks
 * boom and bust together. Marginals stay the calibrated residual
 * distributions because the copula only supplies the quantile.
 */
export function drawWeekOutcomes(
  week: PlayerWeek[],
  residuals: ResidualModel,
  rng: () => number,
  catcherLoadingByTeam?: Map<string, number>,
): Map<string, number> {
  const gameShock = new Map<string, number>();
  const teamShock = new Map<string, number>();

  for (const player of week) {
    if (!gameShock.has(player.gameKey)) {
      gameShock.set(player.gameKey, normalDraw(rng));
    }

    if (!teamShock.has(player.teamId)) {
      teamShock.set(player.teamId, normalDraw(rng));
    }
  }

  const outcomes = new Map<string, number>();

  for (const player of week) {
    const zGame = gameShock.get(player.gameKey)!;
    const zTeam = teamShock.get(player.teamId)!;
    let z: number;

    if (player.position === "QB") {
      z = GAME_LOADING * zGame + Math.sqrt(1 - 0.028) * zTeam;
    } else if (CATCHERS.has(player.position)) {
      const loading = Math.min(
        0.4,
        Math.max(
          0.1,
          catcherLoadingByTeam?.get(player.teamId) ?? QB_TO_CATCHER,
        ),
      );
      const own = Math.sqrt(1 - 0.028 - loading * loading);
      z = GAME_LOADING * zGame + loading * zTeam + own * normalDraw(rng);
    } else {
      z = GAME_LOADING * zGame + Math.sqrt(1 - 0.028) * normalDraw(rng);
    }

    outcomes.set(
      player.playerId,
      player.own
        ? player.own(normalCdf(z))
        : outcomeQuantile(
            residuals, player.position, player.predicted, normalCdf(z),
          ),
    );
  }

  return outcomes;
}

/**
 * One simulated season for a roster. Outcomes get drawn once per
 * player-week and shared by all three policies, so the only difference
 * between policies is which players start.
 */
export function simulateSeason(
  weeks: PlayerWeek[][],
  residuals: ResidualModel,
  staticValues: StaticValues,
  rng: () => number,
): SeasonResult {
  const totals: Record<PolicyName, number> = { hindsight: 0, model: 0, naive: 0 };
  let weekCount = 0;

  for (const week of weeks) {
    if (week.length === 0) {
      continue;
    }

    weekCount++;
    const outcomes = drawWeekOutcomes(week, residuals, rng);

    const scores: Record<PolicyName, (p: PlayerWeek) => number> = {
      hindsight: (p) => outcomes.get(p.playerId) ?? 0,
      model: (p) => p.predicted,
      naive: (p) => staticValues.get(p.playerId) ?? 0,
    };

    for (const policy of Object.keys(scores) as PolicyName[]) {
      const candidates: LineupCandidate[] = week.map((p) => ({
        playerId: p.playerId,
        position: p.position,
        score: scores[policy](p),
      }));

      for (const starter of pickLineup(candidates)) {
        totals[policy] += outcomes.get(starter) ?? 0;
      }
    }
  }

  return {
    meanPoints: {
      hindsight: totals.hindsight / weekCount,
      model: totals.model / weekCount,
      naive: totals.naive / weekCount,
    },
  };
}
