/**
 * Does reading snap share and shrinking a short season help the board?
 *
 * The season model now starts from a level that knows how many games a
 * player's average came off and how much of the offence he was on the
 * field for. This marks that against the model as it was, against his
 * own last season, and against a reader who knew the answer. Nothing
 * trains on the season it predicts.
 *
 * The old model is kept here rather than imported, because it no
 * longer exists in the source and a number needs something to beat.
 *
 * Run: npx tsx scripts/seasonShrinkEval.ts
 */

import {
  buildSeasonData,
  examplesForTransition,
  fitSeasonModel,
  predictSeasonBlend,
  seasonGbmRow,
  seasonRidgeRow,
  SEASON_RIDGE_FEATURES,
  type SeasonExample,
} from "../src/features/seasonModel.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import { fitGbm, predictGbm, type GbmModel } from "../src/backtest/gbm.js";
import { spearman } from "../src/backtest/metrics.js";

const ALL_SEASONS: number[] = [];

for (let s = 2015; s <= 2025; s++) {
  ALL_SEASONS.push(s);
}

const MARKED = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
/** where the snap columns start, so the old row is the row before them */
const BEFORE_SNAPS = SEASON_RIDGE_FEATURES.indexOf("snapShare");

interface OldFit {
  weight: number;
  ridgeWeights: number[];
  gbm: GbmModel;
}

function oldBlend(e: SeasonExample, weight: number): number {
  if (e.prev2Ppg === undefined) {
    return e.prevPpg;
  }

  return (1 - weight) * e.prevPpg + weight * e.prev2Ppg;
}

const oldRidgeRow = (e: SeasonExample): number[] =>
  seasonRidgeRow(e).slice(0, BEFORE_SNAPS);

function fitOldModel(examples: SeasonExample[]): OldFit {
  let weight = 0;
  let best = -Infinity;

  for (let candidate = 0; candidate <= 0.5; candidate += 0.05) {
    const score = spearman(
      examples.map((e) => oldBlend(e, candidate)),
      examples.map((e) => e.actualPpg),
    );

    if (score > best) {
      best = score;
      weight = candidate;
    }
  }

  const usable = examples.filter((e) => oldBlend(e, weight) > 1);
  const y = usable.map((e) =>
    Math.log(Math.min(Math.max(e.actualPpg / oldBlend(e, weight), 0.2), 3)),
  );

  return {
    weight,
    ridgeWeights: fitRidge(usable.map(oldRidgeRow), y, 5),
    gbm: fitGbm(usable.map(seasonGbmRow), y, {
      trees: 200, depth: 3, rate: 0.05, minLeaf: 40,
    }),
  };
}

function predictOld(fit: OldFit, e: SeasonExample): number {
  const ridgeAdj = predictRidge(fit.ridgeWeights, oldRidgeRow(e));
  const gbmAdj = predictGbm(fit.gbm, seasonGbmRow(e));

  return oldBlend(e, fit.weight) * Math.exp((ridgeAdj + gbmAdj) / 2);
}

function mae(predicted: number[], actual: number[]): number {
  return (
    predicted.reduce((s, p, i) => s + Math.abs(p - actual[i]!), 0) /
    predicted.length
  );
}

function correlation(a: number[], b: number[]): number {
  const n = a.length;
  const meanA = a.reduce((s, x) => s + x, 0) / n;
  const meanB = b.reduce((s, x) => s + x, 0) / n;
  let together = 0;
  let spreadA = 0;
  let spreadB = 0;

  for (let i = 0; i < n; i++) {
    together += (a[i]! - meanA) * (b[i]! - meanB);
    spreadA += (a[i]! - meanA) ** 2;
    spreadB += (b[i]! - meanB) ** 2;
  }

  return together / Math.sqrt(spreadA * spreadB);
}

function line(
  label: string,
  predicted: number[],
  actual: number[],
  rows: SeasonExample[],
): void {
  const only = (test: (e: SeasonExample) => boolean): string => {
    const kept = rows.map((e, i) => [e, i] as const).filter(([e]) => test(e));

    return mae(
      kept.map(([, i]) => predicted[i]!),
      kept.map(([, i]) => actual[i]!),
    ).toFixed(3);
  };

  console.log(
    `${label.padEnd(22)}${mae(predicted, actual).toFixed(3)}  ` +
      `${correlation(predicted, actual).toFixed(3)}  ` +
      `${spearman(predicted, actual).toFixed(3)}  ` +
      `${only((e) => e.snapPct > 0 && e.snapPct < 0.5).padEnd(11)}` +
      `${only((e) => e.gamesPrev <= 10)}`,
  );
}

async function main(): Promise<void> {
  const data = await buildSeasonData(ALL_SEASONS);
  const byYear = new Map<number, SeasonExample[]>();

  for (let target = 2017; target <= 2025; target++) {
    byYear.set(target, await examplesForTransition(target, data));
  }

  const rows: SeasonExample[] = [];
  const actual: number[] = [];
  const now: number[] = [];
  const before: number[] = [];

  for (const season of MARKED) {
    const train: SeasonExample[] = [];

    for (let s = 2017; s < season; s++) {
      train.push(...byYear.get(s)!);
    }

    const fit = fitSeasonModel(train);
    const was = fitOldModel(train);

    for (const e of byYear.get(season)!) {
      rows.push(e);
      actual.push(e.actualPpg);
      now.push(predictSeasonBlend(fit, e));
      before.push(predictOld(was, e));
    }

    console.log(`${season}: fit on ${train.length} earlier transitions`);
  }

  console.log(`\n${rows.length} players over ${MARKED[0]} to 2025\n`);
  console.log("".padEnd(22) + "MAE    corr   spear  part-time  under 11 games");
  line("model as it was", before, actual, rows);
  line("with snaps, shrunk", now, actual, rows);
  line("his own last season", rows.map((e) => e.prevPpg), actual, rows);
  line("knew the answer", actual, actual, rows);
}

await main();
