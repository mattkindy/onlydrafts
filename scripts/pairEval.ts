/**
 * Weekly start/sit, scored the way it is used.
 *
 * For every week of the test seasons, take each pair of same-position men
 * who both played and ask how often the one a method liked better actually
 * scored more. Pairs are split by how far apart the two projections were,
 * so a method that only wins the easy calls is visible. The slate-wide
 * Spearman for the same methods is the last column, for comparison.
 *
 * Run: npx tsx scripts/pairEval.ts [--test 2024,2025]
 */

import { spearman } from "../src/backtest/metrics.js";
import {
  addPairs,
  emptyTally,
  PAIR_GAPS,
  pairRate,
  type PairEntry,
  type PairTally,
} from "../src/backtest/pairs.js";
import { predictRidge } from "../src/backtest/ridge.js";
import { loadGames } from "../src/data/nflverse.js";
import {
  fitWeeklyByPosition,
  POSITION_EXTRAS,
  predictWeeklyByPosition,
} from "../src/features/fitWeeklyByPosition.js";
import type { WeeklyExample } from "../src/features/weekly.js";
import { weeklyExamplesForSeason, weeklyRow } from "../src/features/weeklyModel.js";

const POSITIONS = ["QB", "RB", "WR", "TE"];
const TRAIN_FROM = 2016;

/**
 * He played if he touched it or scored anything. A man carried as inactive
 * still gets a row of zeroes in the weekly file, and nobody was choosing
 * between him and anyone.
 */
function played(e: WeeklyExample): boolean {
  return e.targetTargets + e.targetCarries > 0 || e.target !== 0;
}

function parseList(arg: string | undefined, fallback: number[]): number[] {
  if (!arg) {
    return fallback;
  }

  return arg.split(",").map(Number);
}

type Predict = (e: WeeklyExample) => number;

/** mean Spearman across the position-weeks with at least ten men */
function slateSpearman(examples: WeeklyExample[], predict: Predict): number {
  const groups = groupBySlate(examples);
  const scores: number[] = [];

  for (const list of groups.values()) {
    if (list.length < 10) {
      continue;
    }

    scores.push(spearman(list.map(predict), list.map((e) => e.target)));
  }

  return scores.reduce((s, x) => s + x, 0) / scores.length;
}

/** one position on one week, which is the set a manager chooses within */
function groupBySlate(examples: WeeklyExample[]): Map<string, WeeklyExample[]> {
  const groups = new Map<string, WeeklyExample[]>();

  for (const e of examples) {
    const key = `${e.position}|${e.week}`;
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }

  return groups;
}

function tallyFor(
  examples: WeeklyExample[],
  predict: Predict,
): Map<string, PairTally> {
  const tally = emptyTally();

  for (const list of groupBySlate(examples).values()) {
    const entries: PairEntry[] = list.map((e) => ({
      predicted: predict(e),
      actual: e.target,
    }));
    addPairs(tally, entries);
  }

  return tally;
}

const pct = (value: number) =>
  Number.isNaN(value) ? "    -" : `${(value * 100).toFixed(1).padStart(5)}`;

async function main(): Promise<void> {
  const testFlag = process.argv.indexOf("--test");
  const testSeasons = parseList(
    testFlag === -1 ? undefined : process.argv[testFlag + 1],
    [2024, 2025],
  );

  const games = await loadGames();
  const last = Math.max(...testSeasons);
  const cache = new Map<number, WeeklyExample[]>();

  for (let season = TRAIN_FROM; season <= last; season++) {
    cache.set(season, await weeklyExamplesForSeason(season, games));
  }

  console.log("weekly start/sit, pairs of same-position men who both played");
  console.log(
    "ceiling from weeklyCeilingEval on 2025: knowing a man's touches ahead of",
  );
  console.log(
    "time ranks his own weeks at .543, knowing his yards at .805, and his own",
  );
  console.log("average across his weeks at -.002.\n");

  for (const season of testSeasons) {
    const train = [...cache.keys()]
      .filter((s) => s < season)
      .flatMap((s) => cache.get(s)!);
    const test = cache.get(season)!.filter(played);

    const perPosition = fitWeeklyByPosition(train);
    const flat = fitWeeklyByPosition(train, {});
    const baseOnly = fitWeeklyByPosition(
      train,
      Object.fromEntries(POSITIONS.map((p) => [p, []])),
    );

    const methods: [string, Predict][] = [
      ["his average", (e) => e.seasonPpg],
      ["last four", (e) => e.last4],
      ["ridge pooled", (e) => predictRidge(flat.pooled, weeklyRow(e))],
      ["ridge per pos (base)", (e) => predictWeeklyByPosition(baseOnly, e)],
      ["ridge per pos", (e) => predictWeeklyByPosition(perPosition, e)],
    ];

    console.log(`${season}: ${test.length} player-weeks who played`);
    console.log(
      `extras: ${Object.entries(POSITION_EXTRAS)
        .map(([p, names]) => `${p} ${names.join("+")}`)
        .join(", ")}`,
    );
    console.log(
      "pos  method                " +
        PAIR_GAPS.map((g) => g.name.padStart(6)).join(" ") +
        "     pairs  spearman",
    );

    for (const position of [...POSITIONS, undefined]) {
      const rows = position
        ? test.filter((e) => e.position === position)
        : test;

      for (const [name, predict] of methods) {
        const tally = tallyFor(rows, predict);
        const cells = PAIR_GAPS.map((g) => pct(pairRate(tally, g.name))).join(" ");
        const pairs = tally.get("all")!.total;
        const rho = slateSpearman(rows, predict).toFixed(3).padStart(9);
        console.log(
          `${(position ?? "all").padEnd(4)} ${name.padEnd(21)} ${cells} ${String(pairs).padStart(9)} ${rho}`,
        );
      }

      console.log("");
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
