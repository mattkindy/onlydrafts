// Measures how weekly prediction errors move together inside one NFL
// game, split into teammate pairs and opponent pairs. The estimates
// become the copula loadings in the simulator.

import { loadGames } from "../src/data/nflverse.js";
import {
  weeklyExamplesForSeason,
  weeklyRow,
} from "../src/features/weeklyModel.js";
import type { WeeklyExample } from "../src/features/weekly.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";

const SEASONS = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023];

async function main(): Promise<void> {
  const games = await loadGames();
  const examples: WeeklyExample[] = [];

  for (const season of SEASONS) {
    examples.push(...(await weeklyExamplesForSeason(season, games)));
  }

  const weights = fitRidge(
    examples.map(weeklyRow),
    examples.map((e) => e.target),
    25,
  );

  const byPosition = new Map<string, number[]>();
  const residualOf = new Map<WeeklyExample, number>();

  for (const e of examples) {
    const residual = e.target - predictRidge(weights, weeklyRow(e));
    residualOf.set(e, residual);
    const list = byPosition.get(e.position) ?? [];
    list.push(residual);
    byPosition.set(e.position, list);
  }

  const stdByPosition = new Map<string, number>();

  for (const [position, list] of byPosition) {
    const mean = list.reduce((s, x) => s + x, 0) / list.length;
    const variance =
      list.reduce((s, x) => s + (x - mean) * (x - mean), 0) / list.length;
    stdByPosition.set(position, Math.sqrt(variance));
  }

  const byGame = new Map<string, WeeklyExample[]>();

  for (const e of examples) {
    const key = `${e.season}|${e.week}|${[e.teamId, e.opponent].sort().join("@")}`;
    const list = byGame.get(key) ?? [];
    list.push(e);
    byGame.set(key, list);
  }

  const sums = new Map<string, { sum: number; pairs: number }>();

  const record = (kind: string, product: number) => {
    const entry = sums.get(kind) ?? { sum: 0, pairs: 0 };
    entry.sum += product;
    entry.pairs++;
    sums.set(kind, entry);
  };

  const isCatcher = (position: string) => position === "WR" || position === "TE";

  for (const group of byGame.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        const za = residualOf.get(a)! / stdByPosition.get(a.position)!;
        const zb = residualOf.get(b)! / stdByPosition.get(b.position)!;
        const product = za * zb;

        if (a.teamId !== b.teamId) {
          record("opponents", product);
          continue;
        }

        const positions = [a.position, b.position];
        const qbCatcher =
          (a.position === "QB" && isCatcher(b.position)) ||
          (b.position === "QB" && isCatcher(a.position));

        if (qbCatcher) {
          record("teammates QB-catcher", product);
        } else if (positions.includes("RB")) {
          record("teammates with RB", product);
        } else {
          record("teammates other", product);
        }
      }
    }
  }

  for (const [kind, { sum, pairs }] of sums) {
    console.log(
      `${kind.padEnd(22)} ${(sum / pairs).toFixed(4)} (${pairs} pairs)`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
