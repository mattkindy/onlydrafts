// Scores the model against actual preseason ADP with training limited
// to earlier years: does it know anything drafters had not priced in?
// Run: npx tsx scripts/adpEval.ts

import { loadAdp } from "../src/data/adp.js";
import { normalizeName } from "../src/data/names.js";
import { spearman } from "../src/backtest/metrics.js";
import {
  buildSeasonData,
  examplesForTransition,
  fitSeasonModel,
  predictSeasonBlend,
  projectDraftExamples,
  type SeasonExample,
} from "../src/features/seasonModel.js";
import {
  fitRookieModel,
  predictRookie,
  rookiesFor,
  type RookieExample,
} from "../src/features/rookies.js";

const ALL_SEASONS = [
  2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025,
];
const TEST_SEASONS = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
const MIN_TARGET_GAMES = 4;

interface Row {
  name: string;
  adp: number;
  projection: number;
  prevPpg: number;
  actual: number;
}

async function main(): Promise<void> {
  const data = await buildSeasonData(ALL_SEASONS);
  const results = new Map<string, number[]>([
    ["adp", []],
    ["model", []],
    ["prev-ppg", []],
    ["adp+model", []],
  ]);
  const topResults = new Map<string, number[]>(
    [...results.keys()].map((k) => [k, []]),
  );

  for (const target of TEST_SEASONS) {
    const train: SeasonExample[] = [];

    for (const t of ALL_SEASONS.filter((s) => s >= 2017 && s < target)) {
      train.push(...(await examplesForTransition(t, data)));
    }

    const fit = fitSeasonModel(train);
    const board = await projectDraftExamples(target, data);
    const adp = await loadAdp(target);

    const rookieTrain: RookieExample[] = [];

    for (const t of ALL_SEASONS.filter((s) => s >= 2017 && s < target)) {
      rookieTrain.push(...(await rookiesFor(t, data)));
    }

    const rookieWeights = fitRookieModel(rookieTrain);
    const rookieClass = await rookiesFor(target, data);
    const prevNames = data.get(target - 1)!.summaries;
    const actuals = data.get(target)!.summaries;

    const rows: Row[] = [];

    for (const e of board) {
      const name = prevNames.get(e.playerId)?.playerName;
      const entry = name
        ? adp.get(`${normalizeName(name)}|${e.position}`)
        : undefined;
      const actual = actuals.get(e.playerId);

      if (!entry || !actual || actual.games < MIN_TARGET_GAMES) {
        continue;
      }

      rows.push({
        name: name!,
        adp: entry.adp,
        projection: predictSeasonBlend(fit, e),
        prevPpg: e.prevPpg,
        actual: actual.pointsPerGame,
      });
    }

    const score = (subset: Row[], into: Map<string, number[]>) => {
      const actual = subset.map((r) => r.actual);
      into.get("adp")!.push(spearman(subset.map((r) => -r.adp), actual));
      into.get("model")!.push(spearman(subset.map((r) => r.projection), actual));
      into.get("prev-ppg")!.push(spearman(subset.map((r) => r.prevPpg), actual));

      const adpRank = rankOf(subset.map((r) => -r.adp));
      const modelRank = rankOf(subset.map((r) => r.projection));
      into
        .get("adp+model")!
        .push(spearman(adpRank.map((r, i) => -(r + modelRank[i]!)), actual));
    };

    for (const r of rookieClass) {
      const entry = adp.get(`${normalizeName(r.name)}|${r.position}`);

      if (!entry || r.actualPpg === undefined || r.actualGames < MIN_TARGET_GAMES) {
        continue;
      }

      rows.push({
        name: r.name,
        adp: entry.adp,
        projection: predictRookie(rookieWeights, r),
        prevPpg: 0,
        actual: r.actualPpg,
      });
    }

    score(rows, results);
    score([...rows].sort((a, b) => a.adp - b.adp).slice(0, 30), topResults);

    console.log(`${target}: ${rows.length} players matched to ADP`);
  }

  const report = (label: string, map: Map<string, number[]>) => {
    console.log(`\n${label}:`);

    for (const [name, list] of map) {
      const mean = list.reduce((s, x) => s + x, 0) / list.length;
      console.log(
        `  ${name.padEnd(10)} mean ${mean.toFixed(3)}  per season: ${list.map((s) => s.toFixed(3)).join(", ")}`,
      );
    }
  };

  report("all matched players", results);
  report("top 30 by ADP", topResults);
}

function rankOf(values: number[]): number[] {
  const order = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => b.value - a.value);
  const ranks = new Array<number>(values.length);
  order.forEach((entry, rank) => {
    ranks[entry.index] = rank + 1;
  });
  return ranks;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
