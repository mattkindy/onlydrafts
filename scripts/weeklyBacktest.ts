// Weekly backtest: rank players within each position for each week of
// the test seasons, scoring the ridge against season average and last
// four games. Run: npx tsx scripts/weeklyBacktest.ts

import { loadGames } from "../src/data/nflverse.js";
import { type WeeklyExample } from "../src/features/weekly.js";
import {
  WEEKLY_FEATURES,
  weeklyExamplesForSeason,
  weeklyRow,
} from "../src/features/weeklyModel.js";
import { spearman } from "../src/backtest/metrics.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import {
  buildResidualModel,
  outcomeQuantile,
} from "../src/backtest/intervals.js";

const POSITIONS = ["QB", "RB", "WR", "TE"];

function parseList(arg: string | undefined, fallback: number[]): number[] {
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

/** mean Spearman across position-weeks with at least ten players */
function weeklyScore(
  examples: WeeklyExample[],
  predict: (e: WeeklyExample) => number,
): number {
  const groups = new Map<string, WeeklyExample[]>();

  for (const e of examples) {
    const key = `${e.position}|${e.week}`;
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }

  const scores: number[] = [];

  for (const list of groups.values()) {
    if (list.length < 10) {
      continue;
    }

    scores.push(spearman(list.map(predict), list.map((e) => e.target)));
  }

  return scores.reduce((s, x) => s + x, 0) / scores.length;
}

interface TwoStage {
  targets: number[];
  carries: number[];
  points: number[];
}

function opportunityRow(e: WeeklyExample): number[] {
  return [
    1,
    e.position === "QB" ? 1 : 0,
    e.position === "RB" ? 1 : 0,
    e.position === "TE" ? 1 : 0,
    e.targetsRecent,
    e.carriesRecent,
    e.snapRecent,
    e.impliedTotal,
  ];
}

function fitTwoStage(train: WeeklyExample[]): TwoStage {
  const X = train.map(opportunityRow);
  const targets = fitRidge(X, train.map((e) => e.targetTargets), 25);
  const carries = fitRidge(X, train.map((e) => e.targetCarries), 25);

  const pointsX = train.map((e) =>
    pointsRow(e, predictRidge(targets, opportunityRow(e)), predictRidge(carries, opportunityRow(e))),
  );
  const points = fitRidge(pointsX, train.map((e) => e.target), 25);

  return { targets, carries, points };
}

function pointsRow(
  e: WeeklyExample,
  predTargets: number,
  predCarries: number,
): number[] {
  return [
    1,
    e.position === "QB" ? 1 : 0,
    e.position === "RB" ? 1 : 0,
    e.position === "TE" ? 1 : 0,
    predTargets,
    predCarries,
    e.last4,
    e.seasonPpg,
    e.oppIndex,
    e.impliedTotal,
    e.airYardsRecent,
  ];
}

function predictTwoStage(model: TwoStage, e: WeeklyExample): number {
  const opportunity = opportunityRow(e);
  return predictRidge(
    model.points,
    pointsRow(
      e,
      predictRidge(model.targets, opportunity),
      predictRidge(model.carries, opportunity),
    ),
  );
}

function fitPerPosition(
  train: WeeklyExample[],
): Map<string, number[]> {
  const weights = new Map<string, number[]>();

  for (const position of POSITIONS) {
    const rows = train.filter((e) => e.position === position);
    weights.set(
      position,
      fitRidge(rows.map(weeklyRow), rows.map((e) => e.target), 25),
    );
  }

  return weights;
}

/** each season from 2019 on gets tested with only earlier seasons trained */
async function rollingWeekly(
  seasons: number[],
  cache: Map<number, WeeklyExample[]>,
): Promise<void> {
  const names = ["season-avg", "last4", "ridge", "ridge-per-pos", "two-stage"];
  const scores = new Map<string, number[]>(names.map((n) => [n, []]));
  const testSeasons = seasons.filter((s) => s >= seasons[0]! + 3);

  for (const testSeason of testSeasons) {
    const train = seasons
      .filter((s) => s < testSeason)
      .flatMap((s) => cache.get(s)!);
    const test = cache.get(testSeason)!;
    const weights = fitRidge(train.map(weeklyRow), train.map((e) => e.target), 25);
    const perPosition = fitPerPosition(train);
    const twoStage = fitTwoStage(train);

    const predictors: ((e: WeeklyExample) => number)[] = [
      (e) => e.seasonPpg,
      (e) => e.last4,
      (e) => predictRidge(weights, weeklyRow(e)),
      (e) =>
        predictRidge(perPosition.get(e.position) ?? weights, weeklyRow(e)),
      (e) => predictTwoStage(twoStage, e),
    ];

    for (let v = 0; v < names.length; v++) {
      scores.get(names[v]!)!.push(weeklyScore(test, predictors[v]!));
    }
  }

  console.log(`rolling weekly evaluation, test seasons ${testSeasons.join(", ")}:`);

  for (const [name, list] of scores) {
    const mean = list.reduce((s, x) => s + x, 0) / list.length;
    console.log(
      `  ${name.padEnd(12)} mean ${mean.toFixed(3)}  per season: ${list.map((s) => s.toFixed(3)).join(", ")}`,
    );
  }

  console.log("");
}

async function main(): Promise<void> {
  const trainFlag = process.argv.indexOf("--train");
  const testFlag = process.argv.indexOf("--test");
  const trainSeasons = parseList(
    trainFlag === -1 ? undefined : process.argv[trainFlag + 1],
    [2016, 2017, 2018, 2019, 2020, 2021, 2022],
  );
  const testSeasons = parseList(
    testFlag === -1 ? undefined : process.argv[testFlag + 1],
    [2023, 2024],
  );

  const games = await loadGames();
  const allSeasons = [...trainSeasons, ...testSeasons];
  const cache = new Map<number, WeeklyExample[]>();

  for (const season of allSeasons) {
    cache.set(season, await weeklyExamplesForSeason(season, games));
  }

  await rollingWeekly(allSeasons, cache);

  const train = trainSeasons.flatMap((s) => cache.get(s)!);

  const weights = fitRidge(train.map(weeklyRow), train.map((e) => e.target), 25);

  console.log(`train examples: ${train.length}`);
  console.log("weights:");

  for (let i = 0; i < WEEKLY_FEATURES.length; i++) {
    console.log(`  ${WEEKLY_FEATURES[i]!.padEnd(12)} ${weights[i]!.toFixed(3)}`);
  }

  const variants: [string, (e: WeeklyExample) => number][] = [
    ["season-avg", (e) => e.seasonPpg],
    ["last4", (e) => e.last4],
    ["ridge", (e) => predictRidge(weights, weeklyRow(e))],
  ];

  const residualModel = buildResidualModel(
    train.map((e) => ({
      position: e.position,
      predicted: predictRidge(weights, weeklyRow(e)),
      actual: e.target,
    })),
    5,
  );

  console.log("\ninterval calibration on the test seasons:");
  console.log("pos   inside-80%  inside-50%  mean-80%-width");

  for (const position of POSITIONS) {
    let in80 = 0;
    let in50 = 0;
    let width = 0;
    let count = 0;

    for (const season of testSeasons) {
      for (const e of cache.get(season)!) {
        if (e.position !== position) {
          continue;
        }

        const predicted = predictRidge(weights, weeklyRow(e));
        const lo80 = outcomeQuantile(residualModel, position, predicted, 0.1);
        const hi80 = outcomeQuantile(residualModel, position, predicted, 0.9);
        const lo50 = outcomeQuantile(residualModel, position, predicted, 0.25);
        const hi50 = outcomeQuantile(residualModel, position, predicted, 0.75);

        count++;
        width += hi80 - lo80;

        if (e.target >= lo80 && e.target <= hi80) {
          in80++;
        }

        if (e.target >= lo50 && e.target <= hi50) {
          in50++;
        }
      }
    }

    console.log(
      `${position.padEnd(4)} ${((in80 / count) * 100).toFixed(1).padStart(9)}% ${((in50 / count) * 100).toFixed(1).padStart(10)}% ${(width / count).toFixed(1).padStart(13)}`,
    );
  }

  for (const season of testSeasons) {
    const test = cache.get(season)!;
    console.log(`\n${season}: ${test.length} player-weeks`);

    for (const position of [...POSITIONS, undefined]) {
      const rows = position
        ? test.filter((e) => e.position === position)
        : test;
      const scores = variants
        .map(
          ([name, predict]) =>
            `${name} ${weeklyScore(rows, predict).toFixed(3)}`,
        )
        .join("  ");
      console.log(`  ${(position ?? "all").padEnd(4)} ${scores}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
