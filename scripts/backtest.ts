// Season backtest: the last transition is the test set; earlier ones
// train the model, and a rolling pass scores every eligible transition.
// Run: npx tsx scripts/backtest.ts --seasons 2016-2024

import { spearman } from "../src/backtest/metrics.js";
import {
  SEASON_POSITIONS,
  SEASON_RIDGE_FEATURES,
  blended,
  buildSeasonData,
  examplesForTransition,
  fitSeasonModel,
  predictSeason,
  type SeasonExample,
} from "../src/features/seasonModel.js";

function parseSeasons(arg: string | undefined): number[] {
  const fallback = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024];

  if (!arg) {
    return fallback;
  }

  const range = arg.match(/^(\d{4})-(\d{4})$/);

  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }

  return arg.split(",").map(Number);
}

function variantsFor(
  train: SeasonExample[],
): [string, (e: SeasonExample) => number][] {
  const fit = fitSeasonModel(train);

  return [
    ["carry-forward", (e) => e.prevPpg],
    [
      "blended+groups",
      (e) => blended(e, fit.weight) * (fit.ratios.get(e.group) ?? 1),
    ],
    ["blended+ridge", (e) => predictSeason(fit, e)],
  ];
}

function rollingEvaluation(
  targets: number[],
  transitions: Map<number, SeasonExample[]>,
): void {
  const names = ["carry-forward", "blended+groups", "blended+ridge"];
  const scores = new Map<string, number[]>(names.map((n) => [n, []]));

  for (let i = 2; i < targets.length; i++) {
    const test = transitions.get(targets[i]!)!;
    const train = targets.slice(0, i).flatMap((t) => transitions.get(t)!);
    const variants = variantsFor(train);
    const actual = test.map((e) => e.actualPpg);

    for (const [name, predict] of variants) {
      scores.get(name)!.push(spearman(test.map(predict), actual));
    }
  }

  console.log("rolling evaluation, all positions pooled:");

  for (const [name, list] of scores) {
    const mean = list.reduce((s, x) => s + x, 0) / list.length;
    console.log(
      `  ${name.padEnd(16)} mean ${mean.toFixed(3)}  per season: ${list.map((s) => s.toFixed(3)).join(", ")}`,
    );
  }

  console.log("");
}

async function main(): Promise<void> {
  const flag = process.argv.indexOf("--seasons");
  const seasons = parseSeasons(
    flag === -1 ? undefined : process.argv[flag + 1],
  );

  const data = await buildSeasonData(seasons);
  const targets = seasons.slice(1);
  const transitions = new Map<number, SeasonExample[]>();

  for (const target of targets) {
    transitions.set(target, await examplesForTransition(target, data));
  }

  rollingEvaluation(targets, transitions);

  const testTarget = targets[targets.length - 1]!;
  const train = targets.slice(0, -1).flatMap((t) => transitions.get(t)!);
  const test = transitions.get(testTarget)!;
  const fit = fitSeasonModel(train);

  console.log(`test transition: ${testTarget - 1}->${testTarget}`);
  console.log(`train examples: ${train.length}`);
  console.log(`blend weight on season minus two: ${fit.weight.toFixed(2)}`);
  console.log("group ratios:");

  for (const [group, ratio] of [...fit.ratios.entries()].sort()) {
    const count = train.filter((e) => e.group === group).length;
    console.log(`  ${group.padEnd(22)} ${ratio.toFixed(3)}  (n=${count})`);
  }

  console.log("ridge weights (log-ratio scale):");

  for (let i = 0; i < SEASON_RIDGE_FEATURES.length; i++) {
    console.log(
      `  ${SEASON_RIDGE_FEATURES[i]!.padEnd(18)} ${fit.ridgeWeights[i]!.toFixed(3)}`,
    );
  }

  const variants = variantsFor(train);

  console.log("\nSpearman on the test transition:");
  console.log(
    `pos     n  ${variants.map(([name]) => name.padStart(15)).join("")}`,
  );

  for (const position of [...SEASON_POSITIONS, undefined]) {
    const rows = position
      ? test.filter((e) => e.position === position)
      : test;

    if (rows.length < 10) {
      continue;
    }

    const actual = rows.map((e) => e.actualPpg);
    const scores = variants.map(([, predict]) =>
      spearman(rows.map(predict), actual),
    );

    console.log(
      `${(position ?? "all").padEnd(4)} ${String(rows.length).padStart(5)}  ${scores.map((s) => s.toFixed(3).padStart(15)).join("")}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
