/**
 * A season, simulated week by week, so a player's line comes out as a
 * distribution rather than a projection.
 *
 * Two kinds of doubt have to be kept apart. Within a season a man's
 * week wanders around his role, which the weekly draw handles already.
 * Between seasons the role itself is a guess: last year's goal-line
 * back may be this year's third of a committee. Drawing a role once
 * per simulated season and playing it out is what stops the model
 * being certain about something it read off one year. Without that
 * second draw the bands come out at two thirds of what they promise.
 */

import type { Draws } from "./playerWeek.js";
import { fantasyPoints, type ScoringRules } from "../scoring/fantasyPoints.js";
import {
  SITUATIONS, simulateSituationalWeek,
  type SituationalRole, type SituationalTeam,
} from "./situationalWeek.js";

export interface SeasonSettings {
  weeks: number;
  runs: number;
  scoring: ScoringRules;
  /** how wrong last season's role can be about this one, on a log scale */
  roleDrift: number;
}

/**
 * `roleDrift` of 0.9 is what makes an 80% band hold 79.6% of the weeks
 * that followed, fitted on 2024 and scored on 2025. It is a large
 * number and it is doing more than one job: some of it is genuine
 * doubt about a role, and some is standing in for what the model does
 * not yet carry, chiefly the opponent and how badly a knock hurts.
 */
export const DEFAULT_SEASON = { weeks: 17, runs: 2000, roleDrift: 0.9 };

export interface Spread {
  p10: number; p25: number; median: number; p75: number; p90: number;
}

export interface PlayerSeason {
  playerId: string;
  /**
   * One week, over every week of every simulated season. This is what
   * a lineup decision needs, and it is much wider than `seasonAverage`,
   * which smooths seventeen of them together.
   */
  weekly: Spread;
  /** what he averages across a season, season to season */
  seasonAverage: Spread;
  total: { p10: number; median: number; p90: number; mean: number };
  gamesPlayed: number;
  /** share of simulated seasons with at least one week over 25 */
  bigWeekChance: number;
}

/** one draw of what his role might turn out to be this year */
function drawRole(role: SituationalRole, drift: number, draws: Draws): SituationalRole {
  const targetShare = { ...role.targetShare };
  const carryShare = { ...role.carryShare };
  const scoresPerCatch = { ...role.scoresPerCatch };
  const scoresPerCarry = { ...role.scoresPerCarry };
  // one shock for the man, so a back who loses the job loses it in
  // every situation rather than only at the goal line
  const his = Math.exp(draws.normal() * drift);

  for (const situation of SITUATIONS) {
    const bySituation = Math.exp(draws.normal() * drift * 0.5);
    const move = his * bySituation;
    targetShare[situation] = Math.min(0.6, role.targetShare[situation] * move);
    carryShare[situation] = Math.min(0.9, role.carryShare[situation] * move);
    // how often he finishes wanders far less than how often he is used
    const finish = Math.exp(draws.normal() * 0.2);
    scoresPerCatch[situation] = Math.min(0.9, role.scoresPerCatch[situation] * finish);
    scoresPerCarry[situation] = Math.min(0.9, role.scoresPerCarry[situation] * finish);
  }

  return { ...role, targetShare, carryShare, scoresPerCatch, scoresPerCarry };
}

const quantile = (sorted: number[], p: number) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;

export function simulateSeason(
  team: SituationalTeam,
  roster: SituationalRole[],
  settings: SeasonSettings,
  draws: Draws,
): PlayerSeason[] {
  const totals = roster.map(() => [] as number[]);
  const perGame = roster.map(() => [] as number[]);
  const everyWeek = roster.map(() => [] as number[]);
  const games = roster.map(() => [] as number[]);
  const bigWeeks = roster.map(() => 0);

  for (let run = 0; run < settings.runs; run++) {
    const drawn = roster.map((role) => drawRole(role, settings.roleDrift, draws));
    const seasonTotal = roster.map(() => 0);
    const seasonGames = roster.map(() => 0);
    const seasonBig = roster.map(() => false);

    for (let week = 0; week < settings.weeks; week++) {
      simulateSituationalWeek(team, drawn, draws).forEach((line, i) => {
        if (!line.played) {
          return;
        }

        const points = fantasyPoints(line, settings.scoring);
        seasonTotal[i] = seasonTotal[i]! + points;
        seasonGames[i] = seasonGames[i]! + 1;
        everyWeek[i]!.push(points);

        if (points >= 25) {
          seasonBig[i] = true;
        }
      });
    }

    roster.forEach((_, i) => {
      totals[i]!.push(seasonTotal[i]!);
      games[i]!.push(seasonGames[i]!);

      if (seasonGames[i]! > 0) {
        perGame[i]!.push(seasonTotal[i]! / seasonGames[i]!);
      }

      if (seasonBig[i]) {
        bigWeeks[i] = bigWeeks[i]! + 1;
      }
    });
  }

  const spreadOf = (values: number[]): Spread => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      p10: quantile(sorted, 0.1), p25: quantile(sorted, 0.25),
      median: quantile(sorted, 0.5), p75: quantile(sorted, 0.75),
      p90: quantile(sorted, 0.9),
    };
  };

  return roster.map((role, i) => {
    const season = [...totals[i]!].sort((a, b) => a - b);

    return {
      playerId: role.playerId,
      weekly: spreadOf(everyWeek[i]!),
      seasonAverage: spreadOf(perGame[i]!),
      total: {
        p10: quantile(season, 0.1), median: quantile(season, 0.5),
        p90: quantile(season, 0.9),
        mean: season.reduce((a, b) => a + b, 0) / Math.max(1, season.length),
      },
      gamesPlayed: games[i]!.reduce((a, b) => a + b, 0) / Math.max(1, games[i]!.length),
      bigWeekChance: bigWeeks[i]! / settings.runs,
    };
  });
}
