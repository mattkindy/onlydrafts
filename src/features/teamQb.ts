import type { PlayerWeekStats } from "../data/nflverse.js";
import type { RosterAppearance } from "../graph/build.js";
import type { SeasonSummary } from "./seasonSummary.js";

/** Each team's primary QB for a season: the QB with the most logged weeks. */
export function primaryQbByTeam(
  weeks: PlayerWeekStats[],
): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();

  for (const week of weeks) {
    if (week.position !== "QB") {
      continue;
    }

    const perQb = counts.get(week.teamId) ?? new Map<string, number>();
    perQb.set(week.playerId, (perQb.get(week.playerId) ?? 0) + 1);
    counts.set(week.teamId, perQb);
  }

  const result = new Map<string, string>();

  for (const [teamId, perQb] of counts) {
    let best = "";
    let bestCount = -1;

    for (const [qbId, count] of perQb) {
      if (count > bestCount) {
        best = qbId;
        bestCount = count;
      }
    }

    result.set(teamId, best);
  }

  return result;
}

/**
 * Each team's projected week-1 starter, judged with draft-day
 * information only: QBs on the week-1 roster, ranked by their previous
 * season's points per game.
 */
export function projectedQbByTeam(
  weekOneRoster: RosterAppearance[],
  prevSummaries: Map<string, SeasonSummary>,
): Map<string, string> {
  const result = new Map<string, string>();
  const bestPpg = new Map<string, number>();

  for (const appearance of weekOneRoster) {
    if (appearance.rawPosition.toUpperCase() !== "QB" || appearance.week !== 1) {
      continue;
    }

    const ppg = prevSummaries.get(appearance.playerId)?.pointsPerGame ?? 0;

    if (ppg >= (bestPpg.get(appearance.teamId) ?? -1)) {
      bestPpg.set(appearance.teamId, ppg);
      result.set(appearance.teamId, appearance.playerId);
    }
  }

  return result;
}
