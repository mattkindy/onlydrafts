// First backtest: does knowing a player changed teams improve on the
// carry-forward baseline (this season's PPG = last season's)? The last
// transition is the test set. Run: npx tsx scripts/backtest.ts

import { loadPlayerStats } from "../src/data/nflverse.js";
import { presets } from "../src/scoring/fantasyPoints.js";
import {
  summarizeSeason,
  type SeasonSummary,
} from "../src/features/seasonSummary.js";
import { spearman } from "../src/backtest/metrics.js";

const POSITIONS = ["QB", "RB", "WR", "TE"];
const MIN_GAMES = 6;

interface Example {
  playerId: string;
  position: string;
  prevPpg: number;
  actualPpg: number;
  moved: boolean;
}

function examplesFor(
  prev: Map<string, SeasonSummary>,
  target: Map<string, SeasonSummary>,
): Example[] {
  const examples: Example[] = [];

  for (const [playerId, was] of prev) {
    const is = target.get(playerId);

    if (!is || !POSITIONS.includes(was.position)) {
      continue;
    }

    if (was.games < MIN_GAMES || is.games < MIN_GAMES) {
      continue;
    }

    examples.push({
      playerId,
      position: was.position,
      prevPpg: was.pointsPerGame,
      actualPpg: is.pointsPerGame,
      moved: was.primaryTeamId !== is.primaryTeamId,
    });
  }

  return examples;
}

function meanRatio(examples: Example[]): number {
  const ratios = examples
    .filter((e) => e.prevPpg > 1)
    .map((e) => Math.min(e.actualPpg / e.prevPpg, 3));

  if (ratios.length === 0) {
    return 1;
  }

  return ratios.reduce((s, r) => s + r, 0) / ratios.length;
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

async function main(): Promise<void> {
  const flag = process.argv.indexOf("--seasons");
  const seasons = parseSeasons(
    flag === -1 ? undefined : process.argv[flag + 1],
  );

  const summaries = new Map<number, Map<string, SeasonSummary>>();

  for (const season of seasons) {
    summaries.set(
      season,
      summarizeSeason(await loadPlayerStats(season), presets.ppr),
    );
  }

  const transitions = seasons.slice(1).map((target) => ({
    target,
    examples: examplesFor(summaries.get(target - 1)!, summaries.get(target)!),
  }));

  const test = transitions[transitions.length - 1]!;
  const train = transitions.slice(0, -1);

  const trainExamples = train.flatMap((t) => t.examples);
  const stayerRatio = meanRatio(trainExamples.filter((e) => !e.moved));
  const moverRatio = meanRatio(trainExamples.filter((e) => e.moved));

  console.log(
    `train transitions: ${train.map((t) => `${t.target - 1}->${t.target}`).join(", ")}`,
  );
  console.log(`test transition: ${test.target - 1}->${test.target}`);
  console.log(
    `train examples: ${trainExamples.length} (${trainExamples.filter((e) => e.moved).length} movers)`,
  );
  console.log(
    `learned ratios: stayers ${stayerRatio.toFixed(3)}, movers ${moverRatio.toFixed(3)}\n`,
  );

  console.log("Spearman within position on the test transition:");
  console.log("pos     n  movers  baseline  with-move-adj");

  const groups: (string | undefined)[] = [...POSITIONS, undefined];

  for (const position of groups) {
    const rows = position
      ? test.examples.filter((e) => e.position === position)
      : test.examples;

    if (rows.length < 10) {
      continue;
    }

    const actual = rows.map((e) => e.actualPpg);
    const baseline = rows.map((e) => e.prevPpg);
    const adjusted = rows.map(
      (e) => e.prevPpg * (e.moved ? moverRatio : stayerRatio),
    );

    const movers = rows.filter((e) => e.moved).length;
    const sBase = spearman(baseline, actual);
    const sAdj = spearman(adjusted, actual);

    console.log(
      `${(position ?? "all").padEnd(4)} ${String(rows.length).padStart(5)} ${String(movers).padStart(7)}  ${sBase.toFixed(3).padStart(8)}  ${sAdj.toFixed(3).padStart(13)}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
