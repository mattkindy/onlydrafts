/**
 * Pulling a weekly row's recent means toward what the player did last
 * season, by how many games he has behind him this one.
 *
 * The weekly ridge learns its coefficients on rows where every "recent"
 * column is a mean over four games. In week 2 the same column is one box
 * score, so a quarterback who threw for 13 yards arrives at the fit
 * looking like a quarterback who averages 13, and the fit gives him 2.8
 * points for the week. Shrinking each mean toward his own previous season, with
 * weight k standing for how many games of prior information he brings,
 * puts a one-game row back on the scale the fit expects and leaves a
 * four-game row nearly where it was. A player with no previous season
 * of his own falls back to the mean for his position.
 */

import type { PlayerWeekStats } from "../data/nflverse.js";
import { fantasyPoints, type ScoringRules } from "../scoring/fantasyPoints.js";
import { RECENT_GAMES } from "./recentWindow.js";
import type { WeeklyExample } from "./weekly.js";

/**
 * How much prior information a previous season is worth, in games.
 * scripts/earlyWeekEval.ts swept 1, 2, 3, 5 and 8 over 2021 to 2025: one
 * game saves 0.061 points of error a week over weeks 2 to 4 with a
 * standard error of 0.015, and is the only setting that costs nothing
 * from week 5 on, where the ridge already sees four game means.
 */
export const SHIPPED_PRIOR_GAMES = 1;

/** games of a previous season before it says anything about a player */
const MIN_PRIOR_GAMES = 4;

const PRIOR_POSITIONS = new Set(["QB", "RB", "WR", "TE"]);

/** a player's previous season, per game, in the columns the ridge reads */
export interface RecentPrior {
  points: number;
  targets: number;
  carries: number;
  airYards: number;
  receptions: number;
  recYds: number;
  rushYds: number;
  targetShare: number;
}

export interface RecentPriors {
  byPlayer: Map<string, RecentPrior>;
  byPosition: Map<string, RecentPrior>;
}

const EMPTY: RecentPrior = {
  points: 0,
  targets: 0,
  carries: 0,
  airYards: 0,
  receptions: 0,
  recYds: 0,
  rushYds: 0,
  targetShare: 0,
};

function meanPrior(rows: PlayerWeekStats[], rules: ScoringRules): RecentPrior {
  const per = (pick: (r: PlayerWeekStats) => number) =>
    rows.reduce((sum, r) => sum + pick(r), 0) / rows.length;

  return {
    points: per((r) => fantasyPoints(r.statLine, rules)),
    targets: per((r) => r.targets),
    carries: per((r) => r.carries),
    airYards: per((r) => r.airYards),
    receptions: per((r) => r.statLine.receptions),
    recYds: per((r) => r.statLine.recYds),
    rushYds: per((r) => r.statLine.rushYds),
    targetShare: per((r) => r.targetShare),
  };
}

function averaged(priors: RecentPrior[]): RecentPrior {
  const per = (pick: (p: RecentPrior) => number) =>
    priors.reduce((sum, p) => sum + pick(p), 0) / priors.length;

  return {
    points: per((p) => p.points),
    targets: per((p) => p.targets),
    carries: per((p) => p.carries),
    airYards: per((p) => p.airYards),
    receptions: per((p) => p.receptions),
    recYds: per((p) => p.recYds),
    rushYds: per((p) => p.rushYds),
    targetShare: per((p) => p.targetShare),
  };
}

/** what each player and each position did per game in the season given */
export function buildRecentPriors(
  prevStats: PlayerWeekStats[],
  rules: ScoringRules,
): RecentPriors {
  const byPlayerRows = new Map<string, PlayerWeekStats[]>();

  for (const row of prevStats) {
    if (!PRIOR_POSITIONS.has(row.position)) {
      continue;
    }

    const his = byPlayerRows.get(row.playerId) ?? [];
    his.push(row);
    byPlayerRows.set(row.playerId, his);
  }

  const byPlayer = new Map<string, RecentPrior>();
  const grouped = new Map<string, RecentPrior[]>();

  for (const [playerId, rows] of byPlayerRows) {
    if (rows.length < MIN_PRIOR_GAMES) {
      continue;
    }

    const prior = meanPrior(rows, rules);
    byPlayer.set(playerId, prior);

    const position = rows[rows.length - 1]!.position;
    grouped.set(position, [...(grouped.get(position) ?? []), prior]);
  }

  const byPosition = new Map<string, RecentPrior>();

  for (const [position, priors] of grouped) {
    byPosition.set(position, averaged(priors));
  }

  return { byPlayer, byPosition };
}

/**
 * The same row with every recent mean pulled toward the player's prior.
 * `priorGames` at or below zero leaves the row alone, which is how the
 * eval asks for the unshrunk model without a second code path.
 */
export function shrinkRecentMeans(
  example: WeeklyExample,
  priors: RecentPriors,
  priorGames: number,
): WeeklyExample {
  if (priorGames <= 0) {
    return example;
  }

  const prior =
    priors.byPlayer.get(example.playerId) ??
    priors.byPosition.get(example.position) ??
    EMPTY;
  const inWindow = Math.min(example.gamesBehind, RECENT_GAMES);
  const pull = (mean: number, toward: number, games: number) =>
    (games * mean + priorGames * toward) / (games + priorGames);
  const recent = (mean: number, toward: number) => pull(mean, toward, inWindow);

  return {
    ...example,
    last4: recent(example.last4, prior.points),
    seasonPpg: pull(example.seasonPpg, prior.points, example.gamesBehind),
    targetsRecent: recent(example.targetsRecent, prior.targets),
    carriesRecent: recent(example.carriesRecent, prior.carries),
    airYardsRecent: recent(example.airYardsRecent, prior.airYards),
    receptionsRecent: recent(example.receptionsRecent, prior.receptions),
    recYdsRecent: recent(example.recYdsRecent, prior.recYds),
    rushYdsRecent: recent(example.rushYdsRecent, prior.rushYds),
    targetsExpected: recent(example.targetsExpected, prior.targets),
    carriesExpected: recent(example.carriesExpected, prior.carries),
    targetShareRecent: recent(example.targetShareRecent, prior.targetShare),
  };
}
