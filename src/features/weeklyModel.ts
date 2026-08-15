import {
  loadGames,
  loadPlayerStats,
  loadSnapCounts,
} from "../data/nflverse.js";
import { presets } from "../scoring/fantasyPoints.js";
import { summarizeSeason } from "./seasonSummary.js";
import { buildWeeklyExamples, type WeeklyExample } from "./weekly.js";

export const WEEKLY_FEATURES = [
  "intercept",
  "isQB",
  "isRB",
  "isTE",
  "last4",
  "seasonPpg",
  "prevPpg",
  "snapRecent",
  "oppIndex",
  "home",
  "impliedTotal",
  "targetsRecent",
  "carriesRecent",
  "airYardsRecent",
] as const;

export function weeklyRow(e: WeeklyExample): number[] {
  return [
    1,
    e.position === "QB" ? 1 : 0,
    e.position === "RB" ? 1 : 0,
    e.position === "TE" ? 1 : 0,
    e.last4,
    e.seasonPpg,
    e.prevPpg,
    e.snapRecent,
    e.oppIndex,
    e.home ? 1 : 0,
    e.impliedTotal,
    e.targetsRecent,
    e.carriesRecent,
    e.airYardsRecent,
  ];
}

export async function weeklyExamplesForSeason(
  season: number,
  games: Awaited<ReturnType<typeof loadGames>>,
): Promise<WeeklyExample[]> {
  const stats = await loadPlayerStats(season);
  const prevStats = await loadPlayerStats(season - 1);
  const prevSummaries = summarizeSeason(prevStats, presets.ppr);
  const prevPpg = new Map<string, number>();

  for (const [id, summary] of prevSummaries) {
    if (summary.games >= 4) {
      prevPpg.set(id, summary.pointsPerGame);
    }
  }

  return buildWeeklyExamples(
    season,
    stats,
    prevPpg,
    games,
    await loadSnapCounts(season),
    presets.ppr,
  );
}
