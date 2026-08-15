// How well do we predict box score components and team scoring, next
// to recent-form baselines and the Vegas lines?
// Run: npx tsx scripts/gameEval.ts

import { loadGames } from "../src/data/nflverse.js";
import {
  weeklyExamplesForSeason,
  weeklyRow,
} from "../src/features/weeklyModel.js";
import type { WeeklyExample } from "../src/features/weekly.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import { spearman } from "../src/backtest/metrics.js";

const TRAIN = [2016, 2017, 2018, 2019, 2020, 2021, 2022];
const TEST = [2023, 2024];

const STATS: [string, (e: WeeklyExample) => number, (e: WeeklyExample) => number][] = [
  ["targets", (e) => e.targetTargets, (e) => e.targetsRecent],
  ["carries", (e) => e.targetCarries, (e) => e.carriesRecent],
  ["receptions", (e) => e.targetReceptions, (e) => e.receptionsRecent],
  ["recYds", (e) => e.targetRecYds, (e) => e.recYdsRecent],
  ["rushYds", (e) => e.targetRushYds, (e) => e.rushYdsRecent],
];

async function main(): Promise<void> {
  const games = await loadGames();
  const train: WeeklyExample[] = [];
  const test: WeeklyExample[] = [];

  for (const season of TRAIN) {
    train.push(...(await weeklyExamplesForSeason(season, games)));
  }

  for (const season of TEST) {
    test.push(...(await weeklyExamplesForSeason(season, games)));
  }

  console.log("box score components, rank correlation on 2023 and 2024:");
  console.log("stat         model  recent-mean");

  for (const [label, actualOf, recentOf] of STATS) {
    const weights = fitRidge(train.map(weeklyRow), train.map(actualOf), 25);
    const actual = test.map(actualOf);
    const model = spearman(
      test.map((e) => predictRidge(weights, weeklyRow(e))),
      actual,
    );
    const recent = spearman(test.map(recentOf), actual);
    console.log(
      `${label.padEnd(12)} ${model.toFixed(3)}       ${recent.toFixed(3)}`,
    );
  }

  const pointsWeights = fitRidge(
    train.map(weeklyRow),
    train.map((e) => e.target),
    25,
  );

  const teamActual = new Map<string, number>();

  for (const game of games) {
    if (!TEST.includes(game.season) || game.homeScore === undefined) {
      continue;
    }

    teamActual.set(`${game.homeTeamId}|${game.season}|${game.week}`, game.homeScore);
    teamActual.set(`${game.awayTeamId}|${game.season}|${game.week}`, game.awayScore ?? 0);
  }

  const teamPredicted = new Map<string, number>();
  const teamVegas = new Map<string, number>();

  for (const e of test) {
    const key = `${e.teamId}|${e.season}|${e.week}`;
    teamPredicted.set(
      key,
      (teamPredicted.get(key) ?? 0) + predictRidge(pointsWeights, weeklyRow(e)),
    );
    teamVegas.set(key, e.impliedTotal);
  }

  const keys = [...teamPredicted.keys()].filter((k) => teamActual.has(k));
  const actualPoints = keys.map((k) => teamActual.get(k)!);

  console.log(`\nteam points, ${keys.length} team games in 2023 and 2024:`);
  console.log(
    `  summed player predictions  ${spearman(keys.map((k) => teamPredicted.get(k)!), actualPoints).toFixed(3)}`,
  );
  console.log(
    `  vegas implied total        ${spearman(keys.map((k) => teamVegas.get(k)!), actualPoints).toFixed(3)}`,
  );

  const both = keys.map(
    (k) => teamVegas.get(k)! + teamPredicted.get(k)! / 10,
  );
  console.log(
    `  vegas plus our sum         ${spearman(both, actualPoints).toFixed(3)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
