/**
 * Weekly start/sit, scored the way it is used.
 *
 * For every week of the test seasons, take each pair of same-position men
 * who both played and ask how often the one a method liked better actually
 * scored more. Pairs are split by how far apart the two projections were,
 * so a method that only wins the easy calls is visible. The slate-wide
 * Spearman for the same methods is the last column, for comparison.
 *
 * Run: npx tsx scripts/pairEval.ts [--test 2024,2025] [--weeks 1-17]
 */

import { spearman } from "../src/backtest/metrics.js";
import {
  addCredit,
  addPairs,
  creditFor,
  emptyTally,
  PAIR_GAPS,
  pairRate,
  type PairEntry,
  type PairTally,
} from "../src/backtest/pairs.js";
import { predictRidge } from "../src/backtest/ridge.js";
import { loadGames } from "../src/data/nflverse.js";
import {
  loadSleeperWeekly,
  projectionKey,
} from "../src/data/sleeperProjections.js";
import {
  fitWeeklyByPosition,
  POSITION_EXTRAS,
  predictWeeklyByPosition,
} from "../src/features/fitWeeklyByPosition.js";
import {
  blendPoints,
  fitBlendWeight,
  type BlendEntry,
} from "../src/features/sleeperBlend.js";
import {
  bandMeans,
  calibrate,
  CALIBRATION_BANDS,
  fitSleeperCalibration,
  type CalibrationEntry,
} from "../src/features/sleeperCalibration.js";
import {
  bestMix,
  mixPoints,
  shareGrid,
  type MixEntry,
} from "../src/features/mixWeights.js";
import { WEEKLY_WALK_SHARE } from "../src/features/walkWeek.js";
import {
  loadWalkWeekly,
  walkKey,
} from "../src/features/walkWeeklyCache.js";
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

interface WeekRange {
  first: number;
  last: number;
}

/** "1-17", or a single week. Every week counts when nothing is asked for */
function parseWeeks(arg: string | undefined): WeekRange {
  if (!arg) {
    return { first: 1, last: 18 };
  }

  const [first, last] = arg.split("-").map(Number);
  return { first: first!, last: last ?? first! };
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

/**
 * The pairs where our ridge and Sleeper made a call, split by whether they
 * picked the same man. How far apart the two disagree is taken as the mean
 * of the two gaps, so a pair both methods see as close does not land in the
 * same bucket as one they both see as wide but opposite.
 */
function duelTallies(
  examples: WeeklyExample[],
  ours: Predict,
  sleeper: Predict,
): { agree: Map<string, PairTally>; disagree: Map<string, PairTally> } {
  const agree = emptyTally();
  const disagree = emptyTally();

  for (const list of groupBySlate(examples).values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        const ourGap = ours(a) - ours(b);
        const theirGap = sleeper(a) - sleeper(b);

        if (ourGap === 0 || theirGap === 0) {
          continue;
        }

        const ourPick = ourGap > 0 ? a : b;
        const other = ourGap > 0 ? b : a;
        const size = (Math.abs(ourGap) + Math.abs(theirGap)) / 2;
        const credit = creditFor(ourPick.target, other.target);
        const sameMan = ourGap > 0 === theirGap > 0;
        addCredit(sameMan ? agree : disagree, size, credit);
      }
    }
  }

  return { agree, disagree };
}

interface SeasonSet {
  season: number;
  played: WeeklyExample[];
  covered: WeeklyExample[];
  /** the covered weeks the walk has also played, which is a few of them */
  walked: WeeklyExample[];
  ours: Predict;
  pooled: Predict;
  sleeper: Predict;
  corrected: Predict;
  walk: Predict;
}

/** the slates one position played, as the blend fitter wants them */
function blendSlates(
  set: SeasonSet,
  position: string,
  sleeper: Predict,
): BlendEntry[][] {
  const rows = set.covered.filter((e) => e.position === position);

  return [...groupBySlate(rows).values()].map((list) =>
    list.map((e) => ({
      ours: set.ours(e),
      sleeper: sleeper(e),
      actual: e.target,
    })),
  );
}

function fitWeights(
  sources: SeasonSet[],
  sleeperOf: (set: SeasonSet) => Predict,
): Map<string, number> {
  const weights = new Map<string, number>();

  for (const position of POSITIONS) {
    weights.set(
      position,
      fitBlendWeight(
        sources.flatMap((set) => blendSlates(set, position, sleeperOf(set))),
      ),
    );
  }

  return weights;
}

/** the walked weeks of one position, as several voices on the same men */
function mixSlates(
  set: SeasonSet,
  position: string,
  voices: Predict[],
): MixEntry[][] {
  const rows = set.walked.filter((e) => e.position === position);

  return [...groupBySlate(rows).values()].map((list) =>
    list.map((e) => ({
      parts: voices.map((voice) => voice(e)),
      actual: e.target,
    })),
  );
}

/** the shares for each position, chosen on the seasons handed in */
function fitShares(
  sources: SeasonSet[],
  voicesOf: (set: SeasonSet) => Predict[],
  grid: number[][],
): Map<string, number[]> {
  const shares = new Map<string, number[]>();

  for (const position of POSITIONS) {
    shares.set(
      position,
      bestMix(
        sources.flatMap((set) => mixSlates(set, position, voicesOf(set))),
        grid,
      ),
    );
  }

  return shares;
}

/**
 * The seasons a correction for the test year may be fit on: the ones before
 * it, the way the ridge trains. Sleeper's file only goes back to 2024, so
 * the earliest test year has nothing before it and falls back to the later
 * season, which is how the blend weight has always been chosen.
 */
function calibrationSeasons(test: number, covered: number[]): number[] {
  const earlier = covered.filter((s) => s < test);

  if (earlier.length > 0) {
    return earlier;
  }

  return covered.filter((s) => s !== test);
}

function calibrationRows(
  examples: WeeklyExample[],
  sleeper: (e: WeeklyExample) => number | undefined,
): CalibrationEntry[] {
  const rows: CalibrationEntry[] = [];

  for (const e of examples) {
    const points = sleeper(e);

    if (points === undefined) {
      continue;
    }

    rows.push({ position: e.position, sleeper: points, actual: e.target });
  }

  return rows;
}

/** every method against the same men, by how far apart its two calls were */
function printMethods(rows: WeeklyExample[], methods: [string, Predict][]): void {
  console.log(
    "pos  method                " +
      PAIR_GAPS.map((g) => g.name.padStart(6)).join(" ") +
      "     pairs  spearman",
  );

  for (const position of [...POSITIONS, undefined]) {
    const mine = position ? rows.filter((e) => e.position === position) : rows;

    for (const [name, predict] of methods) {
      const tally = tallyFor(mine, predict);
      const cells = PAIR_GAPS.map((g) => pct(pairRate(tally, g.name))).join(" ");
      const pairs = tally.get("all")!.total;
      const rho = slateSpearman(mine, predict).toFixed(3).padStart(9);
      console.log(
        `${(position ?? "all").padEnd(4)} ${name.padEnd(21)} ${cells} ${String(pairs).padStart(9)} ${rho}`,
      );
    }

    console.log("");
  }
}

/** what a method said against what was scored, by the level it said */
function printBands(
  label: string,
  rows: WeeklyExample[],
  named: [string, Predict][],
): void {
  console.log(`${label} mean projected against mean scored, by band`);
  console.log(
    "pos  band  " +
      named.map(([name]) => `| ${name.padEnd(9)} weeks  said scored `).join(""),
  );

  for (const position of POSITIONS) {
    const mine = rows.filter((e) => e.position === position);
    const tables = named.map(([, predict]) =>
      bandMeans(mine.map((e) => ({ projected: predict(e), actual: e.target }))),
    );

    for (const band of CALIBRATION_BANDS) {
      const cells = tables
        .map((table) => {
          const cell = table.get(band.name)!;

          if (cell.weeks === 0) {
            return "| " + "-".padStart(16) + "     -      - ";
          }

          return (
            `| ${String(cell.weeks).padStart(16)} ` +
            `${cell.projected.toFixed(1).padStart(5)} ` +
            `${cell.actual.toFixed(1).padStart(6)} `
          );
        })
        .join("");
      console.log(`${position.padEnd(4)} ${band.name.padEnd(5)} ${cells}`);
    }
  }

  console.log("");
}

/**
 * The walk on the same bench. It has only played the weeks in the cache, so
 * every other method is scored again on those weeks alone, which is the only
 * way the columns are about the same men.
 */
function printWalk(
  set: SeasonSet,
  others: SeasonSet[],
  methods: [string, Predict][],
): void {
  if (set.walked.length === 0) {
    console.log(
      `${set.season}: the walk has played none of these weeks, ` +
        "run scripts/walkWeekCache.ts to give it some\n",
    );
    return;
  }

  const fitOn = others.filter((s) => s.walked.length > 0);
  const shares = fitShares(fitOn, (s) => [s.ours, s.walk], shareGrid(2, 0.05));
  const threeWay = fitShares(
    fitOn,
    (s) => [s.ours, s.corrected, s.walk],
    shareGrid(3, 0.1),
  );
  const shipped: Predict = (e) => {
    const share = WEEKLY_WALK_SHARE[e.position] ?? 0.25;
    return share * set.walk(e) + (1 - share) * set.ours(e);
  };
  const withWalk: [string, Predict][] = [
    ["walk alone", set.walk],
    ["ridge+walk shipped", shipped],
  ];

  if (fitOn.length > 0) {
    withWalk.push(
      [
        "ridge+walk fitted",
        (e) => mixPoints([set.ours(e), set.walk(e)], shares.get(e.position)!),
      ],
      [
        "ridge+cal+walk",
        (e) =>
          mixPoints(
            [set.ours(e), set.corrected(e), set.walk(e)],
            threeWay.get(e.position)!,
          ),
      ],
    );
  }

  const walkWeeks = [...new Set(set.walked.map((e) => e.week))].sort(
    (a, b) => a - b,
  );
  console.log(
    `${set.season} the weeks the walk has played, ${walkWeeks.join(",")}: ` +
      `${set.walked.length} of the covered player-weeks`,
  );

  if (fitOn.length > 0) {
    console.log(
      `walk share, fit on the other season: ${POSITIONS.map(
        (p) => `${p} ${shares.get(p)![1]!.toFixed(2)}`,
      ).join(", ")}`,
    );
    console.log(
      `ridge, corrected sleeper and walk: ${POSITIONS.map(
        (p) => `${p} ${threeWay.get(p)!.map((w) => w.toFixed(2)).join("/")}`,
      ).join(", ")}`,
    );
  }

  printMethods(set.walked, [...methods, ...withWalk]);
}

async function main(): Promise<void> {
  const testFlag = process.argv.indexOf("--test");
  const testSeasons = parseList(
    testFlag === -1 ? undefined : process.argv[testFlag + 1],
    [2024, 2025],
  );

  const weekFlag = process.argv.indexOf("--weeks");
  const weeks = parseWeeks(
    weekFlag === -1 ? undefined : process.argv[weekFlag + 1],
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

  const projections = await loadSleeperWeekly();
  const walkPoints = await loadWalkWeekly();
  const sleeperFor = (e: WeeklyExample) =>
    projections.get(projectionKey(e.season, e.week, e.playerId))?.points;
  const projected = [
    ...new Set([...projections.values()].map((p) => p.season)),
  ].filter((s) => cache.has(s));
  const sets: SeasonSet[] = [];

  for (const season of testSeasons) {
    const train = [...cache.keys()]
      .filter((s) => s < season)
      .flatMap((s) => cache.get(s)!);
    const perPosition = fitWeeklyByPosition(train);
    const flat = fitWeeklyByPosition(train, {});
    const playedRows = cache
      .get(season)!
      .filter((e) => played(e) && e.week >= weeks.first && e.week <= weeks.last);
    const covered = playedRows.filter(
      (e) => sleeperFor(e) !== undefined,
    );
    const fitOn = calibrationSeasons(season, projected);
    const calibration = fitSleeperCalibration(
      calibrationRows(
        fitOn.flatMap((s) => (cache.get(s) ?? []).filter(played)),
        sleeperFor,
      ),
      POSITIONS,
    );
    console.log(
      `${season}: sleeper corrected on ${fitOn.join(",")}, ` +
        POSITIONS.map((p) => {
          const line = calibration.get(p)!;
          return `${p} ${line.intercept.toFixed(2)}+${line.slope.toFixed(2)}x`;
        }).join(", "),
    );

    sets.push({
      season,
      played: playedRows,
      covered,
      walked: covered.filter((e) =>
        walkPoints.has(walkKey(e.season, e.week, e.playerId)),
      ),
      ours: (e) => predictWeeklyByPosition(perPosition, e),
      pooled: (e) => predictRidge(flat.pooled, weeklyRow(e)),
      sleeper: (e) => sleeperFor(e)!,
      corrected: (e) => calibrate(calibration, e.position, sleeperFor(e)!),
      walk: (e) => walkPoints.get(walkKey(e.season, e.week, e.playerId))!.points,
    });
  }

  console.log("");

  for (const set of sets) {
    const { season, played: all, covered, ours, pooled, sleeper } = set;
    const others = sets.filter((s) => s.season !== season);
    const weights = fitWeights(others, (s) => s.sleeper);
    const weightsOnCorrected = fitWeights(others, (s) => s.corrected);
    const corrected = set.corrected;
    const blended: Predict = (e) =>
      blendPoints(ours(e), sleeper(e), weights.get(e.position) ?? 0.5);
    const blendedOnCorrected: Predict = (e) =>
      blendPoints(
        ours(e),
        corrected(e),
        weightsOnCorrected.get(e.position) ?? 0.5,
      );

    const methods: [string, Predict][] = [
      ["his average", (e) => e.seasonPpg],
      ["last four", (e) => e.last4],
      ["ridge pooled", pooled],
      ["ridge per pos", ours],
      ["sleeper", sleeper],
      ["sleeper corrected", corrected],
      ["half and half", (e) => blendPoints(ours(e), sleeper(e), 0.5)],
      ["half and half cal", (e) => blendPoints(ours(e), corrected(e), 0.5)],
      ["fitted blend", blended],
      ["fitted blend cal", blendedOnCorrected],
    ];

    console.log(
      `${season}: ${all.length} player-weeks who played, weeks ${weeks.first}-${weeks.last}`,
    );
    console.log(
      `sleeper covers ${pct(covered.length / all.length)}% of them, ` +
        `${POSITIONS.map(
          (p) =>
            `${p} ${pct(
              covered.filter((e) => e.position === p).length /
                Math.max(all.filter((e) => e.position === p).length, 1),
            ).trim()}`,
        ).join(", ")}`,
    );
    console.log(
      `everything below is scored on the ${covered.length} covered weeks only`,
    );
    console.log(
      `extras: ${Object.entries(POSITION_EXTRAS)
        .map(([p, names]) => `${p} ${names.join("+")}`)
        .join(", ")}`,
    );
    console.log(
      `blend weight on sleeper, fit on the other season: ${POSITIONS.map(
        (p) => `${p} ${weights.get(p)!.toFixed(2)} raw, ` +
          `${weightsOnCorrected.get(p)!.toFixed(2)} corrected`,
      ).join(", ")}`,
    );
    printMethods(covered, methods);
    printBands(`${season}`, covered, [
      ["sleeper", sleeper],
      ["corrected", corrected],
      ["ours", ours],
    ]);
    printWalk(set, others, methods);

    console.log(
      `${season} where the ridge and sleeper pick different men: how often the`,
    );
    console.log("ridge was right, by how far apart the two calls were.");
    console.log(
      "pos  " +
        PAIR_GAPS.map((g) => g.name.padStart(6)).join(" ") +
        "  disagreed     agreed  agree right",
    );

    for (const position of [...POSITIONS, undefined]) {
      const rows = position
        ? covered.filter((e) => e.position === position)
        : covered;
      const { agree, disagree } = duelTallies(rows, ours, sleeper);
      const cells = PAIR_GAPS.map((g) => pct(pairRate(disagree, g.name))).join(" ");
      console.log(
        `${(position ?? "all").padEnd(4)} ${cells} ${String(
          disagree.get("all")!.total,
        ).padStart(10)} ${String(agree.get("all")!.total).padStart(10)} ${pct(
          pairRate(agree, "all"),
        )}`,
      );
    }

    console.log("");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
