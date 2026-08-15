import {
  loadPlayerStats,
  loadSnapCounts,
  loadWeeklyRosters,
} from "../data/nflverse.js";
import { normalizeName } from "../data/names.js";
import { presets } from "../scoring/fantasyPoints.js";
import { summarizeSeason, type SeasonSummary } from "./seasonSummary.js";
import { primaryQbByTeam, projectedQbByTeam } from "./teamQb.js";
import { fitRidge, predictRidge } from "../backtest/ridge.js";
import { spearman } from "../backtest/metrics.js";

export const SEASON_POSITIONS = ["QB", "RB", "WR", "TE"];
export const MIN_GAMES = 6;
const MIN_GROUP = 25;

export type Group =
  | "qb-stayer"
  | "qb-mover"
  | "skill-stayer-same-qb"
  | "skill-stayer-new-qb"
  | "skill-mover";

export interface SeasonExample {
  playerId: string;
  position: string;
  prevPpg: number;
  prev2Ppg?: number;
  actualPpg: number;
  moved: boolean;
  group: Group;
  expYears?: number;
  rookieCapital: number;
  snapPct: number;
}

export interface SeasonData {
  stats: Awaited<ReturnType<typeof loadPlayerStats>>;
  summaries: Map<string, SeasonSummary>;
  snapShare: Map<string, number>;
}

export interface SeasonModelFit {
  weight: number;
  ratios: Map<Group, number>;
  ridgeWeights: number[];
}

export const SEASON_RIDGE_FEATURES = [
  "intercept",
  "isQB",
  "isRB",
  "isTE",
  "moved",
  "newQbSkillStayer",
  "young",
  "vet",
  "movedYoung",
  "movedVet",
  "rookieCap",
  "rookieCapRB",
] as const;

async function loadSnapShare(season: number): Promise<Map<string, number>> {
  const weeks = await loadSnapCounts(season);
  const totals = new Map<string, { sum: number; games: number }>();

  for (const week of weeks) {
    const key = `${normalizeName(week.playerName)}|${week.teamId}`;
    const entry = totals.get(key) ?? { sum: 0, games: 0 };
    const pct = week.offensePct > 1.5 ? week.offensePct / 100 : week.offensePct;
    entry.sum += pct;
    entry.games += 1;
    totals.set(key, entry);
  }

  const result = new Map<string, number>();

  for (const [key, { sum, games }] of totals) {
    result.set(key, games === 0 ? 0 : sum / games);
  }

  return result;
}

export async function buildSeasonData(
  seasons: number[],
): Promise<Map<number, SeasonData>> {
  const data = new Map<number, SeasonData>();

  for (const season of seasons) {
    const stats = await loadPlayerStats(season);
    data.set(season, {
      stats,
      summaries: summarizeSeason(stats, presets.ppr),
      snapShare: await loadSnapShare(season),
    });
  }

  return data;
}

export function groupOf(
  position: string,
  moved: boolean,
  qbChanged: boolean,
): Group {
  if (position === "QB") {
    return moved ? "qb-mover" : "qb-stayer";
  }

  if (moved) {
    return "skill-mover";
  }

  return qbChanged ? "skill-stayer-new-qb" : "skill-stayer-same-qb";
}

interface DraftContext {
  entryYear: Map<string, number>;
  rookieCapital: Map<string, number>;
  weekOneTeam: Map<string, string>;
  projectedQb: Map<string, string>;
  prevQb: Map<string, string>;
}

async function draftContext(
  target: number,
  prev: SeasonData,
): Promise<DraftContext> {
  const rosterWeekOne = await loadWeeklyRosters(target);
  const entryYear = new Map<string, number>();
  const rookieCapital = new Map<string, number>();
  const weekOneTeam = new Map<string, string>();

  for (const appearance of rosterWeekOne) {
    if (appearance.draftYear !== undefined) {
      entryYear.set(appearance.playerId, appearance.draftYear);
    }

    if (appearance.week === 1) {
      weekOneTeam.set(appearance.playerId, appearance.teamId);
    }

    const position = appearance.rawPosition.toUpperCase();

    if (
      appearance.week === 1 &&
      appearance.draftYear === target &&
      SEASON_POSITIONS.includes(position)
    ) {
      const capital =
        appearance.draftOverall === undefined
          ? 0.05
          : (257 - Math.min(appearance.draftOverall, 257)) / 256;
      const key = `${appearance.teamId}|${position}`;
      rookieCapital.set(key, Math.max(rookieCapital.get(key) ?? 0, capital));
    }
  }

  return {
    entryYear,
    rookieCapital,
    weekOneTeam,
    projectedQb: projectedQbByTeam(rosterWeekOne, prev.summaries),
    prevQb: primaryQbByTeam(prev.stats),
  };
}

export async function examplesForTransition(
  target: number,
  data: Map<number, SeasonData>,
): Promise<SeasonExample[]> {
  const prev = data.get(target - 1)!;
  const current = data.get(target)!;
  const prev2 = data.get(target - 2);
  const context = await draftContext(target, prev);
  const examples: SeasonExample[] = [];

  for (const [playerId, was] of prev.summaries) {
    const is = current.summaries.get(playerId);

    if (!is || !SEASON_POSITIONS.includes(was.position)) {
      continue;
    }

    if (was.games < MIN_GAMES || is.games < MIN_GAMES) {
      continue;
    }

    const moved = was.primaryTeamId !== is.primaryTeamId;
    const targetTeam = is.primaryTeamId;
    const qbChanged =
      context.prevQb.get(targetTeam) !== context.projectedQb.get(targetTeam) ||
      context.projectedQb.get(targetTeam) === undefined;
    const entered = context.entryYear.get(playerId);

    examples.push({
      playerId,
      position: was.position,
      prevPpg: was.pointsPerGame,
      prev2Ppg: prev2?.summaries.get(playerId)?.pointsPerGame,
      actualPpg: is.pointsPerGame,
      moved,
      group: groupOf(was.position, moved, qbChanged),
      expYears: entered === undefined ? undefined : target - entered,
      rookieCapital:
        context.rookieCapital.get(`${targetTeam}|${was.position}`) ?? 0,
      snapPct:
        prev.snapShare.get(
          `${normalizeName(was.playerName)}|${was.primaryTeamId}`,
        ) ?? 0,
    });
  }

  return examples;
}

export function blended(example: SeasonExample, weight: number): number {
  if (example.prev2Ppg === undefined) {
    return example.prevPpg;
  }

  return (1 - weight) * example.prevPpg + weight * example.prev2Ppg;
}

export function fitBlendWeight(examples: SeasonExample[]): number {
  let bestWeight = 0;
  let bestScore = -Infinity;

  for (let weight = 0; weight <= 0.5; weight += 0.05) {
    const score = spearman(
      examples.map((e) => blended(e, weight)),
      examples.map((e) => e.actualPpg),
    );

    if (score > bestScore) {
      bestScore = score;
      bestWeight = weight;
    }
  }

  return bestWeight;
}

function meanRatio(pairs: [number, number][]): number {
  const ratios = pairs
    .filter(([basis]) => basis > 1)
    .map(([basis, actual]) => Math.min(actual / basis, 3));

  if (ratios.length === 0) {
    return 1;
  }

  return ratios.reduce((s, r) => s + r, 0) / ratios.length;
}

export function fitGroupRatios(
  examples: SeasonExample[],
  weight: number,
): Map<Group, number> {
  const fallback = new Map<boolean, number>();

  for (const moved of [false, true]) {
    fallback.set(
      moved,
      meanRatio(
        examples
          .filter((e) => e.moved === moved)
          .map((e) => [blended(e, weight), e.actualPpg]),
      ),
    );
  }

  const ratios = new Map<Group, number>();
  const groups = new Set(examples.map((e) => e.group));

  for (const group of groups) {
    const members = examples.filter((e) => e.group === group);

    if (members.length < MIN_GROUP) {
      ratios.set(group, fallback.get(members[0]!.moved) ?? 1);
      continue;
    }

    ratios.set(
      group,
      meanRatio(members.map((e) => [blended(e, weight), e.actualPpg])),
    );
  }

  return ratios;
}

export function seasonRidgeRow(e: SeasonExample): number[] {
  const young = e.expYears !== undefined && e.expYears <= 3 ? 1 : 0;
  const vet = e.expYears !== undefined && e.expYears >= 8 ? 1 : 0;
  const moved = e.moved ? 1 : 0;

  return [
    1,
    e.position === "QB" ? 1 : 0,
    e.position === "RB" ? 1 : 0,
    e.position === "TE" ? 1 : 0,
    moved,
    e.group === "skill-stayer-new-qb" ? 1 : 0,
    young,
    vet,
    moved * young,
    moved * vet,
    e.rookieCapital,
    e.position === "RB" ? e.rookieCapital : 0,
  ];
}

export function fitRatioModel(
  examples: SeasonExample[],
  weight: number,
): number[] {
  const usable = examples.filter((e) => blended(e, weight) > 1);
  const X = usable.map(seasonRidgeRow);
  const y = usable.map((e) =>
    Math.log(Math.min(Math.max(e.actualPpg / blended(e, weight), 0.2), 3)),
  );

  return fitRidge(X, y, 5);
}

export function fitSeasonModel(examples: SeasonExample[]): SeasonModelFit {
  const weight = fitBlendWeight(examples);

  return {
    weight,
    ratios: fitGroupRatios(examples, weight),
    ridgeWeights: fitRatioModel(examples, weight),
  };
}

export function predictSeason(fit: SeasonModelFit, e: SeasonExample): number {
  return (
    blended(e, fit.weight) *
    Math.exp(predictRidge(fit.ridgeWeights, seasonRidgeRow(e)))
  );
}

/**
 * Draft-day projections for a target season, from the previous seasons
 * and the week-1 roster only. Unlike examplesForTransition, nothing
 * here reads the target season's stats, so the board is fair to draft
 * from. actualPpg is set to 0 and never read by prediction.
 */
export async function projectDraftBoard(
  target: number,
  data: Map<number, SeasonData>,
  fit: SeasonModelFit,
): Promise<Map<string, number>> {
  const prev = data.get(target - 1)!;
  const prev2 = data.get(target - 2);
  const context = await draftContext(target, prev);
  const board = new Map<string, number>();

  for (const [playerId, was] of prev.summaries) {
    if (!SEASON_POSITIONS.includes(was.position) || was.games < 4) {
      continue;
    }

    const targetTeam =
      context.weekOneTeam.get(playerId) ?? was.primaryTeamId;
    const moved = was.primaryTeamId !== targetTeam;
    const qbChanged =
      context.prevQb.get(targetTeam) !== context.projectedQb.get(targetTeam) ||
      context.projectedQb.get(targetTeam) === undefined;
    const entered = context.entryYear.get(playerId);

    const example: SeasonExample = {
      playerId,
      position: was.position,
      prevPpg: was.pointsPerGame,
      prev2Ppg: prev2?.summaries.get(playerId)?.pointsPerGame,
      actualPpg: 0,
      moved,
      group: groupOf(was.position, moved, qbChanged),
      expYears: entered === undefined ? undefined : target - entered,
      rookieCapital:
        context.rookieCapital.get(`${targetTeam}|${was.position}`) ?? 0,
      snapPct: 0,
    };

    board.set(playerId, predictSeason(fit, example));
  }

  return board;
}
