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
  ours: Predict;
  pooled: Predict;
  sleeper: Predict;
}

/** the slates one position played, as the blend fitter wants them */
function blendSlates(set: SeasonSet, position: string): BlendEntry[][] {
  const rows = set.covered.filter((e) => e.position === position);

  return [...groupBySlate(rows).values()].map((list) =>
    list.map((e) => ({
      ours: set.ours(e),
      sleeper: set.sleeper(e),
      actual: e.target,
    })),
  );
}

function fitWeights(sources: SeasonSet[]): Map<string, number> {
  const weights = new Map<string, number>();

  for (const position of POSITIONS) {
    weights.set(
      position,
      fitBlendWeight(sources.flatMap((set) => blendSlates(set, position))),
    );
  }

  return weights;
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
    const covered = playedRows.filter((e) =>
      projections.has(projectionKey(e.season, e.week, e.playerId)),
    );

    sets.push({
      season,
      played: playedRows,
      covered,
      ours: (e) => predictWeeklyByPosition(perPosition, e),
      pooled: (e) => predictRidge(flat.pooled, weeklyRow(e)),
      sleeper: (e) =>
        projections.get(projectionKey(e.season, e.week, e.playerId))!.points,
    });
  }

  for (const set of sets) {
    const { season, played: all, covered, ours, pooled, sleeper } = set;
    const weights = fitWeights(sets.filter((s) => s.season !== season));
    const blended: Predict = (e) =>
      blendPoints(ours(e), sleeper(e), weights.get(e.position) ?? 0.5);

    const methods: [string, Predict][] = [
      ["his average", (e) => e.seasonPpg],
      ["last four", (e) => e.last4],
      ["ridge pooled", pooled],
      ["ridge per pos", ours],
      ["sleeper", sleeper],
      ["half and half", (e) => blendPoints(ours(e), sleeper(e), 0.5)],
      ["fitted blend", blended],
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
        (p) => `${p} ${weights.get(p)!.toFixed(2)}`,
      ).join(", ")}`,
    );
    console.log(
      "pos  method                " +
        PAIR_GAPS.map((g) => g.name.padStart(6)).join(" ") +
        "     pairs  spearman",
    );

    for (const position of [...POSITIONS, undefined]) {
      const rows = position
        ? covered.filter((e) => e.position === position)
        : covered;

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
