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
  /** share of the season's points that came from touchdowns */
  tdPointShare: number;
  targetsPerGame: number;
  carriesPerGame: number;
  airYardsPerGame: number;
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
  const tdTotals = new Map<string, number>();
  const volumes = new Map<string, { targets: number; carries: number; airYards: number }>();

  for (const week of weeks) {
    const points = fantasyPoints(week.statLine, rules);
    totals.set(week.playerId, (totals.get(week.playerId) ?? 0) + points);

    const tdPoints =
      week.statLine.passTd * rules.passTd +
      week.statLine.rushTd * rules.rushTd +
      week.statLine.recTd * rules.recTd;
    tdTotals.set(week.playerId, (tdTotals.get(week.playerId) ?? 0) + tdPoints);

    const volume = volumes.get(week.playerId) ?? { targets: 0, carries: 0, airYards: 0 };
    volume.targets += week.targets;
    volume.carries += week.carries;
    volume.airYards += week.airYards;
    volumes.set(week.playerId, volume);

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
        tdPointShare: 0,
        targetsPerGame: 0,
        carriesPerGame: 0,
        airYardsPerGame: 0,
        primaryTeamId: week.teamId,
      });
    }

    const perTeam = teamWeeks.get(week.playerId) ?? new Map<string, number>();
    perTeam.set(week.teamId, (perTeam.get(week.teamId) ?? 0) + 1);
    teamWeeks.set(week.playerId, perTeam);
  }

  for (const [playerId, summary] of summaries) {
    const total = totals.get(playerId) ?? 0;
    summary.pointsPerGame = Math.round((total / summary.games) * 100) / 100;
    summary.tdPointShare = total > 0 ? (tdTotals.get(playerId) ?? 0) / total : 0;

    const volume = volumes.get(playerId);

    if (volume) {
      summary.targetsPerGame = volume.targets / summary.games;
      summary.carriesPerGame = volume.carries / summary.games;
      summary.airYardsPerGame = volume.airYards / summary.games;
    }

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
