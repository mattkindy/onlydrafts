import {
  loadGames,
  loadPlayerStats,
  loadSnapCounts,
  loadWeeklyRosters,
} from "../data/nflverse.js";
import { scoring } from "../scoring/active.js";
import { summarizeSeason } from "./seasonSummary.js";
import {
  buildWeeklyExamples,
  SHIPPED_WINDOWS,
  type WeeklyExample,
  type WeeklyWindows,
} from "./weekly.js";
import {
  buildRecentPriors,
  shrinkRecentMeans,
  SHIPPED_PRIOR_GAMES,
} from "./recentPrior.js";
import {
  loadTendencies,
  loadWeeklyTendencyCounts,
} from "../data/tendencies.js";
import { loadWeeklyAvailability } from "../data/weeklyStatus.js";
import { staffChangesFor } from "./staffChange.js";

const WEEKLY_FEATURES = [
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
  "passTend",
  "passTendRB",
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
    e.passTendency - 0.57,
    e.position === "RB" ? e.passTendency - 0.57 : 0,
  ];
}

/**
 * How a caller may vary what the weekly rows look like. Everything that
 * ships leaves this alone; the early week eval sweeps it.
 */
export interface WeeklySettings {
  windows: WeeklyWindows;
  /** how many games of previous season a recent mean is pulled toward */
  priorGames: number;
}

export const SHIPPED_WEEKLY: WeeklySettings = {
  windows: SHIPPED_WINDOWS,
  priorGames: SHIPPED_PRIOR_GAMES,
};

/** everything a season's rows are built from, loaded once per season */
async function weeklyInputs(season: number) {
  const prevStats = await loadPlayerStats(season - 1).catch(() => []);
  const prevSummaries = summarizeSeason(prevStats, scoring());
  const prevPpg = new Map<string, number>();

  for (const [id, summary] of prevSummaries) {
    if (summary.games >= 4) {
      prevPpg.set(id, summary.pointsPerGame);
    }
  }

  const seasonRates = await loadTendencies();
  const priorSeasonRate = new Map<string, number>();

  for (const [key, tendency] of seasonRates) {
    const [team, s] = key.split("|");

    if (Number(s) === season - 1) {
      priorSeasonRate.set(team!, tendency.neutralPassRate);
    }
  }

  return {
    stats: await loadPlayerStats(season),
    prevPpg,
    priors: buildRecentPriors(prevStats, scoring()),
    snaps: await loadSnapCounts(season),
    tendencies: {
      weekCounts: await loadWeeklyTendencyCounts(),
      priorSeasonRate,
      staff: (await staffChangesFor(season)).changes,
    },
    availability: await loadWeeklyAvailability(season),
    rosters: await loadWeeklyRosters(season).catch(() => []),
  };
}

async function weeklyRows(
  season: number,
  games: Awaited<ReturnType<typeof loadGames>>,
  prospectiveWeek: number | undefined,
  settings: WeeklySettings,
): Promise<WeeklyExample[]> {
  const input = await weeklyInputs(season);

  return buildWeeklyExamples(
    season,
    input.stats,
    input.prevPpg,
    games,
    input.snaps,
    scoring(),
    input.tendencies,
    prospectiveWeek,
    input.availability,
    input.rosters,
    settings.windows,
  ).map((e) => shrinkRecentMeans(e, input.priors, settings.priorGames));
}

export function weeklyExamplesForSeason(
  season: number,
  games: Awaited<ReturnType<typeof loadGames>>,
  settings: WeeklySettings = SHIPPED_WEEKLY,
): Promise<WeeklyExample[]> {
  return weeklyRows(season, games, undefined, settings);
}

/** feature rows for a week that has not been played yet */
export function weeklyProspectiveForWeek(
  season: number,
  week: number,
  games: Awaited<ReturnType<typeof loadGames>>,
  settings: WeeklySettings = SHIPPED_WEEKLY,
): Promise<WeeklyExample[]> {
  return weeklyRows(season, games, week, settings);
}
