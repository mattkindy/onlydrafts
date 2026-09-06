// Adds one candidate feature at a time to each position's weekly ridge,
// printing the Spearman it scores on every test season.
// Run: npx tsx scripts/weeklyAbsenceSweep.ts --train 2016-2023 --test 2024,2025

import { loadGames } from "../src/data/nflverse.js";
import { spearman } from "../src/backtest/metrics.js";
import type { WeeklyExample } from "../src/features/weekly.js";
import { weeklyExamplesForSeason } from "../src/features/weeklyModel.js";
import {
  fitWeeklyByPosition,
  POSITION_EXTRAS,
  predictWeeklyByPosition,
  WEEKLY_EXTRAS,
} from "../src/features/fitWeeklyByPosition.js";

const POSITIONS = ["QB", "RB", "WR", "TE"];

const CANDIDATES = [
  "absence",
  "qbAbsence",
  "questionable",
  "limitedPractice",
  "depthStarter",
  "depthReserve",
  "depthKnown",
];

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

/** mean Spearman across the weeks of one position with ten or more players */
function positionScore(
  examples: WeeklyExample[],
  position: string,
  predict: (e: WeeklyExample) => number,
): number {
  const byWeek = new Map<number, WeeklyExample[]>();

  for (const e of examples) {
    if (e.position !== position) {
      continue;
    }

    const list = byWeek.get(e.week) ?? [];
    list.push(e);
    byWeek.set(e.week, list);
  }

  const scores: number[] = [];

  for (const list of byWeek.values()) {
    if (list.length < 10) {
      continue;
    }

    scores.push(spearman(list.map(predict), list.map((e) => e.target)));
  }

  return scores.reduce((s, x) => s + x, 0) / scores.length;
}

function scoresFor(
  train: WeeklyExample[],
  tests: WeeklyExample[][],
  position: string,
  extras: Record<string, readonly string[]>,
): number[] {
  const model = fitWeeklyByPosition(train, extras);
  return tests.map((test) =>
    positionScore(test, position, (e) => predictWeeklyByPosition(model, e)),
  );
}

async function main(): Promise<void> {
  const trainFlag = process.argv.indexOf("--train");
  const testFlag = process.argv.indexOf("--test");
  const trainSeasons = parseList(
    trainFlag === -1 ? undefined : process.argv[trainFlag + 1],
    [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023],
  );
  const testSeasons = parseList(
    testFlag === -1 ? undefined : process.argv[testFlag + 1],
    [2024, 2025],
  );

  const games = await loadGames();
  const cache = new Map<number, WeeklyExample[]>();

  for (const season of [...trainSeasons, ...testSeasons]) {
    cache.set(season, await weeklyExamplesForSeason(season, games));
  }

  const train = trainSeasons.flatMap((s) => cache.get(s)!);
  const tests = testSeasons.map((s) => cache.get(s)!);
  const show = (list: number[]) => list.map((s) => s.toFixed(4)).join("  ");

  console.log(`train ${trainSeasons.join(",")} rows ${train.length}`);
  console.log(`test seasons ${testSeasons.join("  ")}`);

  for (const position of POSITIONS) {
    const shipped = scoresFor(train, tests, position, POSITION_EXTRAS);
    const base = POSITION_EXTRAS[position] ?? [];
    const ownFit = { ...POSITION_EXTRAS, [position]: base };
    const baseline = scoresFor(train, tests, position, ownFit);

    console.log(`\n${position}`);
    console.log(`  shipped         ${show(shipped)}   extras: ${base.join(",") || "(pooled)"}`);
    console.log(`  own fit, same   ${show(baseline)}`);

    for (const name of CANDIDATES) {
      if (!WEEKLY_EXTRAS[name]) {
        continue;
      }

      const scores = scoresFor(train, tests, position, {
        ...POSITION_EXTRAS,
        [position]: [...base, name],
      });
      const delta = scores.map((s, i) => s - baseline[i]!);
      const keep = delta.every((d) => d > 0) ? "keep" : "";
      console.log(
        `  +${name.padEnd(15)}${show(scores)}   delta ${delta.map((d) => d.toFixed(4).padStart(7)).join(" ")} ${keep}`,
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
