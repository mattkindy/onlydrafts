import type { PlayerWeekStats } from "../data/nflverse.js";
import {
  fantasyPoints,
  type ScoringRules,
} from "../scoring/fantasyPoints.js";

/** One player's season, reduced to what the baseline features need. */
export interface SeasonSummary {
  playerId: string;
  playerName: string;
  position: string;
  season: number;
  games: number;
  pointsPerGame: number;
  /** the team this player logged the most weeks for */
  primaryTeamId: string;
}

export function summarizeSeason(
  weeks: PlayerWeekStats[],
  rules: ScoringRules,
): Map<string, SeasonSummary> {
  const summaries = new Map<string, SeasonSummary>();
  const teamWeeks = new Map<string, Map<string, number>>();
  const totals = new Map<string, number>();

  for (const week of weeks) {
    const points = fantasyPoints(week.statLine, rules);
    totals.set(week.playerId, (totals.get(week.playerId) ?? 0) + points);

    const existing = summaries.get(week.playerId);

    if (existing) {
      existing.games += 1;
    } else {
      summaries.set(week.playerId, {
        playerId: week.playerId,
        playerName: week.playerName,
        position: week.position,
        season: week.season,
        games: 1,
        pointsPerGame: 0,
        primaryTeamId: week.teamId,
      });
    }

    const perTeam = teamWeeks.get(week.playerId) ?? new Map<string, number>();
    perTeam.set(week.teamId, (perTeam.get(week.teamId) ?? 0) + 1);
    teamWeeks.set(week.playerId, perTeam);
  }

  for (const [playerId, summary] of summaries) {
    summary.pointsPerGame =
      Math.round(((totals.get(playerId) ?? 0) / summary.games) * 100) / 100;

    const perTeam = teamWeeks.get(playerId);

    if (perTeam) {
      let best = summary.primaryTeamId;
      let bestCount = 0;

      for (const [teamId, count] of perTeam) {
        if (count > bestCount) {
          best = teamId;
          bestCount = count;
        }
      }

      summary.primaryTeamId = best;
    }
  }

  return summaries;
}
