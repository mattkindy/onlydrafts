// Weekly backtest: rank players within each position for each week of
// the test seasons, scoring the ridge against season average and last
// four games. Run: npx tsx scripts/weeklyBacktest.ts

import {
  loadGames,
  loadPlayerStats,
  loadSnapCounts,
} from "../src/data/nflverse.js";
import { presets } from "../src/scoring/fantasyPoints.js";
import { summarizeSeason } from "../src/features/seasonSummary.js";
import {
  buildWeeklyExamples,
  type WeeklyExample,
} from "../src/features/weekly.js";
import { spearman } from "../src/backtest/metrics.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";

const POSITIONS = ["QB", "RB", "WR", "TE"];

const FEATURES = [
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
] as const;

function row(e: WeeklyExample): number[] {
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
  ];
}

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

async function examplesForSeason(
  season: number,
  games: Awaited<ReturnType<typeof loadGames>>,
): Promise<WeeklyExample[]> {
  const stats = await loadPlayerStats(season);
  const prevStats = await loadPlayerStats(season - 1);
  const prevSummaries = summarizeSeason(prevStats, presets.ppr);
  const prevPpg = new Map<string, number>();

  for (const [id, summary] of prevSummaries) {
    if (summary.games >= 4) {
      prevPpg.set(id, summary.pointsPerGame);
    }
  }

  return buildWeeklyExamples(
    season,
    stats,
    prevPpg,
    games,
    await loadSnapCounts(season),
    presets.ppr,
  );
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
  const train: WeeklyExample[] = [];

  for (const season of trainSeasons) {
    train.push(...(await examplesForSeason(season, games)));
  }

  const weights = fitRidge(train.map(row), train.map((e) => e.target), 25);

  console.log(`train examples: ${train.length}`);
  console.log("weights:");

  for (let i = 0; i < FEATURES.length; i++) {
    console.log(`  ${FEATURES[i]!.padEnd(12)} ${weights[i]!.toFixed(3)}`);
  }

  const variants: [string, (e: WeeklyExample) => number][] = [
    ["season-avg", (e) => e.seasonPpg],
    ["last4", (e) => e.last4],
    ["ridge", (e) => predictRidge(weights, row(e))],
  ];

  for (const season of testSeasons) {
    const test = await examplesForSeason(season, games);
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
