// Checks which draft board better ranks the top of the 2024 pool,
// where drafts are decided. Value = mean weekly model prediction.
// Run: npx tsx scripts/boardDiagnostic.ts

import { loadGames } from "../src/data/nflverse.js";
import {
  weeklyExamplesForSeason,
  weeklyRow,
} from "../src/features/weeklyModel.js";
import type { WeeklyExample } from "../src/features/weekly.js";
import {
  buildSeasonData,
  examplesForTransition,
  fitSeasonModel,
  projectDraftBoard,
  type SeasonExample,
} from "../src/features/seasonModel.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import { spearman } from "../src/backtest/metrics.js";

const games = await loadGames();
const train: WeeklyExample[] = [];

for (const season of [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023]) {
  train.push(...(await weeklyExamplesForSeason(season, games)));
}

const weights = fitRidge(train.map(weeklyRow), train.map((e) => e.target), 25);
const seasonData = await buildSeasonData([2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024]);
const seasonTrain: SeasonExample[] = [];

for (const target of [2017, 2018, 2019, 2020, 2021, 2022, 2023]) {
  seasonTrain.push(...(await examplesForTransition(target, seasonData)));
}

const fit = fitSeasonModel(seasonTrain);
const projections = await projectDraftBoard(2024, seasonData, fit);
const season = await weeklyExamplesForSeason(2024, games);

const simValue = new Map<string, { sum: number; n: number; prev: number }>();

for (const e of season) {
  const entry = simValue.get(e.playerId) ?? { sum: 0, n: 0, prev: 0 };
  entry.sum += predictRidge(weights, weeklyRow(e));
  entry.n++;
  entry.prev = Math.max(entry.prev, e.prevPpg);
  simValue.set(e.playerId, entry);
}

const pool = [...simValue.entries()]
  .map(([id, { sum, n, prev }]) => ({
    id,
    value: sum / n,
    naive: prev,
    model: projections.get(id) ?? 0,
  }))
  .filter((p) => p.naive > 0);

for (const top of [30, 60, 120, 9999]) {
  const slice = [...pool].sort((a, b) => b.naive - a.naive).slice(0, top);
  const naiveCorr = spearman(slice.map((p) => p.naive), slice.map((p) => p.value));
  const modelCorr = spearman(slice.map((p) => p.model), slice.map((p) => p.value));
  console.log(
    `top ${String(top).padStart(4)} by prev ppg: naive ${naiveCorr.toFixed(3)}, model ${modelCorr.toFixed(3)} (${slice.length} players)`,
  );
}
