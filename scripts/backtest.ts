// Backtest of season-to-season PPG prediction. The last transition is
// the test set; earlier ones train the blend weight and group ratios.
// Run: npx tsx scripts/backtest.ts --seasons 2020-2024

import { loadPlayerStats, loadWeeklyRosters } from "../src/data/nflverse.js";
import { presets } from "../src/scoring/fantasyPoints.js";
import {
  summarizeSeason,
  type SeasonSummary,
} from "../src/features/seasonSummary.js";
import { primaryQbByTeam, projectedQbByTeam } from "../src/features/teamQb.js";
import { spearman } from "../src/backtest/metrics.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";

const POSITIONS = ["QB", "RB", "WR", "TE"];
const MIN_GAMES = 6;
const MIN_GROUP = 25;

type Group =
  | "qb-stayer"
  | "qb-mover"
  | "skill-stayer-same-qb"
  | "skill-stayer-new-qb"
  | "skill-mover";

interface Example {
  playerId: string;
  position: string;
  prevPpg: number;
  prev2Ppg?: number;
  actualPpg: number;
  moved: boolean;
  group: Group;
  /** seasons since entering the league, undefined when the roster omits it */
  expYears?: number;
  /** draft capital of the best rookie arriving at this player's position */
  rookieCapital: number;
}

interface SeasonData {
  stats: Awaited<ReturnType<typeof loadPlayerStats>>;
  summaries: Map<string, SeasonSummary>;
}

function groupOf(
  position: string,
  moved: boolean,
  qbChanged: boolean,
): Group {
  if (position === "QB") {
    return moved ? "qb-mover" : "qb-stayer";
  }

  if (moved) {
    return "skill-mover";
  }

  return qbChanged ? "skill-stayer-new-qb" : "skill-stayer-same-qb";
}

async function examplesFor(
  target: number,
  data: Map<number, SeasonData>,
): Promise<Example[]> {
  const prev = data.get(target - 1)!;
  const current = data.get(target)!;
  const prev2 = data.get(target - 2);

  const prevQb = primaryQbByTeam(prev.stats);
  const rosterWeekOne = await loadWeeklyRosters(target);
  const projectedQb = projectedQbByTeam(rosterWeekOne, prev.summaries);

  const entryYear = new Map<string, number>();
  const rookieCapital = new Map<string, number>();

  for (const appearance of rosterWeekOne) {
    if (appearance.draftYear !== undefined) {
      entryYear.set(appearance.playerId, appearance.draftYear);
    }

    const position = appearance.rawPosition.toUpperCase();

    if (
      appearance.week === 1 &&
      appearance.draftYear === target &&
      POSITIONS.includes(position)
    ) {
      const capital =
        appearance.draftOverall === undefined
          ? 0.05
          : (257 - Math.min(appearance.draftOverall, 257)) / 256;
      const key = `${appearance.teamId}|${position}`;
      rookieCapital.set(key, Math.max(rookieCapital.get(key) ?? 0, capital));
    }
  }

  const examples: Example[] = [];

  for (const [playerId, was] of prev.summaries) {
    const is = current.summaries.get(playerId);

    if (!is || !POSITIONS.includes(was.position)) {
      continue;
    }

    if (was.games < MIN_GAMES || is.games < MIN_GAMES) {
      continue;
    }

    const moved = was.primaryTeamId !== is.primaryTeamId;
    const targetTeam = is.primaryTeamId;
    const qbChanged =
      prevQb.get(targetTeam) !== projectedQb.get(targetTeam) ||
      projectedQb.get(targetTeam) === undefined;

    const entered = entryYear.get(playerId);

    examples.push({
      playerId,
      position: was.position,
      prevPpg: was.pointsPerGame,
      prev2Ppg: prev2?.summaries.get(playerId)?.pointsPerGame,
      actualPpg: is.pointsPerGame,
      moved,
      group: groupOf(was.position, moved, qbChanged),
      expYears: entered === undefined ? undefined : target - entered,
      rookieCapital: rookieCapital.get(`${targetTeam}|${was.position}`) ?? 0,
    });
  }

  return examples;
}

function blended(example: Example, weight: number): number {
  if (example.prev2Ppg === undefined) {
    return example.prevPpg;
  }

  return (1 - weight) * example.prevPpg + weight * example.prev2Ppg;
}

function fitBlendWeight(examples: Example[]): number {
  let bestWeight = 0;
  let bestScore = -Infinity;

  for (let weight = 0; weight <= 0.5; weight += 0.05) {
    const score = spearman(
      examples.map((e) => blended(e, weight)),
      examples.map((e) => e.actualPpg),
    );

    if (score > bestScore) {
      bestScore = score;
      bestWeight = weight;
    }
  }

  return bestWeight;
}

function meanRatio(pairs: [number, number][]): number {
  const ratios = pairs
    .filter(([basis]) => basis > 1)
    .map(([basis, actual]) => Math.min(actual / basis, 3));

  if (ratios.length === 0) {
    return 1;
  }

  return ratios.reduce((s, r) => s + r, 0) / ratios.length;
}

function fitGroupRatios(
  examples: Example[],
  weight: number,
): Map<Group, number> {
  const fallback = new Map<boolean, number>();

  for (const moved of [false, true]) {
    fallback.set(
      moved,
      meanRatio(
        examples
          .filter((e) => e.moved === moved)
          .map((e) => [blended(e, weight), e.actualPpg]),
      ),
    );
  }

  const ratios = new Map<Group, number>();
  const groups = new Set(examples.map((e) => e.group));

  for (const group of groups) {
    const members = examples.filter((e) => e.group === group);

    if (members.length < MIN_GROUP) {
      ratios.set(group, fallback.get(members[0]!.moved) ?? 1);
      continue;
    }

    ratios.set(
      group,
      meanRatio(members.map((e) => [blended(e, weight), e.actualPpg])),
    );
  }

  return ratios;
}

const RIDGE_FEATURES = [
  "intercept",
  "isQB",
  "isRB",
  "isTE",
  "moved",
  "newQbSkillStayer",
  "young",
  "vet",
  "movedYoung",
  "movedVet",
  "rookieCap",
  "rookieCapRB",
] as const;

function ridgeRow(e: Example): number[] {
  const young = e.expYears !== undefined && e.expYears <= 3 ? 1 : 0;
  const vet = e.expYears !== undefined && e.expYears >= 8 ? 1 : 0;
  const moved = e.moved ? 1 : 0;

  return [
    1,
    e.position === "QB" ? 1 : 0,
    e.position === "RB" ? 1 : 0,
    e.position === "TE" ? 1 : 0,
    moved,
    e.group === "skill-stayer-new-qb" ? 1 : 0,
    young,
    vet,
    moved * young,
    moved * vet,
    e.rookieCapital,
    e.position === "RB" ? e.rookieCapital : 0,
  ];
}

function fitRatioModel(examples: Example[], weight: number): number[] {
  const usable = examples.filter((e) => blended(e, weight) > 1);
  const X = usable.map(ridgeRow);
  const y = usable.map((e) =>
    Math.log(Math.min(Math.max(e.actualPpg / blended(e, weight), 0.2), 3)),
  );

  return fitRidge(X, y, 5);
}

function parseSeasons(arg: string | undefined): number[] {
  const fallback = [2020, 2021, 2022, 2023, 2024];

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

/**
 * Scores every variant on each transition that has at least two earlier
 * transitions to train on, so a conclusion never rests on one test
 * season.
 */
function rollingEvaluation(
  targets: number[],
  transitions: Map<number, Example[]>,
): void {
  const names = ["carry-forward", "blended+groups", "blended+ridge"];
  const sums = new Map<string, number[]>(names.map((n) => [n, []]));

  for (let i = 2; i < targets.length; i++) {
    const test = transitions.get(targets[i]!)!;
    const train = targets.slice(0, i).flatMap((t) => transitions.get(t)!);

    const weight = fitBlendWeight(train);
    const ratios = fitGroupRatios(train, weight);
    const ridgeWeights = fitRatioModel(train, weight);

    const predictors: ((e: Example) => number)[] = [
      (e) => e.prevPpg,
      (e) => blended(e, weight) * (ratios.get(e.group) ?? 1),
      (e) => blended(e, weight) * Math.exp(predictRidge(ridgeWeights, ridgeRow(e))),
    ];

    const actual = test.map((e) => e.actualPpg);

    for (let v = 0; v < names.length; v++) {
      sums.get(names[v]!)!.push(spearman(test.map(predictors[v]!), actual));
    }
  }

  console.log("rolling evaluation, all positions pooled:");

  for (const [name, scores] of sums) {
    const mean = scores.reduce((s, x) => s + x, 0) / scores.length;
    console.log(
      `  ${name.padEnd(16)} mean ${mean.toFixed(3)}  per season: ${scores.map((s) => s.toFixed(3)).join(", ")}`,
    );
  }

  console.log("");
}

async function main(): Promise<void> {
  const flag = process.argv.indexOf("--seasons");
  const seasons = parseSeasons(
    flag === -1 ? undefined : process.argv[flag + 1],
  );

  const data = new Map<number, SeasonData>();

  for (const season of seasons) {
    const stats = await loadPlayerStats(season);
    data.set(season, { stats, summaries: summarizeSeason(stats, presets.ppr) });
  }

  const targets = seasons.slice(1);
  const transitions = new Map<number, Example[]>();

  for (const target of targets) {
    transitions.set(target, await examplesFor(target, data));
  }

  rollingEvaluation(targets, transitions);

  const testTarget = targets[targets.length - 1]!;
  const trainExamples = targets
    .slice(0, -1)
    .flatMap((t) => transitions.get(t)!);
  const testExamples = transitions.get(testTarget)!;

  const weight = fitBlendWeight(trainExamples);
  const ratios = fitGroupRatios(trainExamples, weight);

  console.log(`test transition: ${testTarget - 1}->${testTarget}`);
  console.log(`train examples: ${trainExamples.length}`);
  console.log(`blend weight on season minus two: ${weight.toFixed(2)}`);
  console.log("group ratios:");

  for (const [group, ratio] of [...ratios.entries()].sort()) {
    const count = trainExamples.filter((e) => e.group === group).length;
    console.log(`  ${group.padEnd(22)} ${ratio.toFixed(3)}  (n=${count})`);
  }

  const ridgeWeights = fitRatioModel(trainExamples, weight);

  console.log("ridge weights (log-ratio scale):");

  for (let i = 0; i < RIDGE_FEATURES.length; i++) {
    console.log(`  ${RIDGE_FEATURES[i]!.padEnd(18)} ${ridgeWeights[i]!.toFixed(3)}`);
  }

  const variants: [string, (e: Example) => number][] = [
    ["carry-forward", (e) => e.prevPpg],
    ["blended+groups", (e) => blended(e, weight) * (ratios.get(e.group) ?? 1)],
    [
      "blended+ridge",
      (e) => blended(e, weight) * Math.exp(predictRidge(ridgeWeights, ridgeRow(e))),
    ],
  ];

  console.log("\nSpearman on the test transition:");
  console.log(`pos     n  ${variants.map(([name]) => name.padStart(15)).join("")}`);

  const groups: (string | undefined)[] = [...POSITIONS, undefined];

  for (const position of groups) {
    const rows = position
      ? testExamples.filter((e) => e.position === position)
      : testExamples;

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
