/**
 * A separate weekly ridge for each position, so a feature that only means
 * something for one of them can be used without confusing the rest.
 *
 * Every position shares a base set of columns, the same ones the pooled
 * model uses minus its position dummies, and then adds a few of its own.
 * Which extras each position gets is the only thing tuned here; the list
 * below is what beat the pooled model on both 2024 and 2025.
 *
 * A position with no entry in POSITION_EXTRAS still gets a pooled ridge
 * fit over every position, which has more rows behind it.
 */

import { fitRidge, predictRidge } from "../backtest/ridge.js";
import { weeklyRow } from "./weeklyModel.js";
import type { WeeklyExample } from "./weekly.js";

export const WEEKLY_LAMBDA = 25;

const BASE_FEATURES = [
  "intercept",
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

function baseRow(e: WeeklyExample): number[] {
  return [
    1,
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

/** the menu a sweep draws on, wider than what any position asks for */
export const WEEKLY_EXTRAS: Record<string, (e: WeeklyExample) => number> = {
  rushYdsRecent: (e) => e.rushYdsRecent,
  recYdsRecent: (e) => e.recYdsRecent,
  receptionsRecent: (e) => e.receptionsRecent,
  spread: (e) => e.spread,
  passTend: (e) => e.passTendency - 0.57,
  backfieldShare: (e) => e.backfieldShareRecent,
  targetShare: (e) => e.targetShareRecent,
  snapSpread: (e) => e.snapRecent * e.spread,
  carriesExpected: (e) => e.carriesExpected,
  targetsExpected: (e) => e.targetsExpected,
  absence: (e) => e.absenceShare,
  qbAbsence: (e) => e.qbAbsenceShare,
  questionable: (e) => (e.questionable ? 1 : 0),
  limitedPractice: (e) => (e.limitedPractice ? 1 : 0),
  depthStarter: (e) => (e.depthKnown && e.depthRank === 1 ? 1 : 0),
  depthReserve: (e) => (e.depthKnown && e.depthRank >= 3 ? 1 : 0),
  depthKnown: (e) => (e.depthKnown ? 1 : 0),
};

export const POSITION_EXTRAS: Record<string, readonly string[]> = {
  QB: ["spread", "snapSpread"],
  RB: ["spread", "rushYdsRecent", "absence", "carriesExpected", "targetsExpected"],
  WR: ["absence", "targetsExpected"],
  TE: ["spread", "passTend", "absence"],
};

export function positionFeatures(position: string): string[] {
  return [...BASE_FEATURES, ...(POSITION_EXTRAS[position] ?? [])];
}

export function positionRow(
  position: string,
  e: WeeklyExample,
  extras: Record<string, readonly string[]> = POSITION_EXTRAS,
): number[] {
  const names = extras[position] ?? [];
  return [...baseRow(e), ...names.map((name) => WEEKLY_EXTRAS[name]!(e))];
}

export interface WeeklyByPosition {
  pooled: number[];
  byPosition: Map<string, number[]>;
  extras: Record<string, readonly string[]>;
}

export function fitWeeklyByPosition(
  train: WeeklyExample[],
  extras: Record<string, readonly string[]> = POSITION_EXTRAS,
): WeeklyByPosition {
  const pooled = fitRidge(
    train.map(weeklyRow),
    train.map((e) => e.target),
    WEEKLY_LAMBDA,
  );
  const byPosition = new Map<string, number[]>();

  for (const position of Object.keys(extras)) {
    const rows = train.filter((e) => e.position === position);

    if (rows.length === 0) {
      continue;
    }

    byPosition.set(
      position,
      fitRidge(
        rows.map((e) => positionRow(position, e, extras)),
        rows.map((e) => e.target),
        WEEKLY_LAMBDA,
      ),
    );
  }

  return { pooled, byPosition, extras };
}

export function predictWeeklyByPosition(
  model: WeeklyByPosition,
  e: WeeklyExample,
): number {
  const weights = model.byPosition.get(e.position);

  if (!weights) {
    return predictRidge(model.pooled, weeklyRow(e));
  }

  return predictRidge(weights, positionRow(e.position, e, model.extras));
}
