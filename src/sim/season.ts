import type { ResidualModel } from "../backtest/intervals.js";
import { sampleOutcome } from "../backtest/intervals.js";
import { pickLineup, type LineupCandidate } from "./lineup.js";

/** what the simulator knows about one rostered player in one week */
export interface PlayerWeek {
  playerId: string;
  position: string;
  predicted: number;
}

/** playerId -> a fixed preseason value, for the naive policy */
export type StaticValues = Map<string, number>;

export type PolicyName = "hindsight" | "model" | "naive";

export interface SeasonResult {
  /** mean weekly starter points per policy */
  meanPoints: Record<PolicyName, number>;
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
    const outcomes = new Map<string, number>();

    for (const player of week) {
      outcomes.set(
        player.playerId,
        sampleOutcome(residuals, player.position, player.predicted, rng),
      );
    }

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
