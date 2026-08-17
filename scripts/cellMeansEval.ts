/**
 * The five-way tie, scored on what a configuration averages rather
 * than on single snaps.
 *
 * Ridge, the factorized model and the two networks all came out level
 * on a play's yards, and that turned out to be a fact about the
 * scoring rule rather than about the models. This asks the question a
 * simulator asks: how close is each to what a configuration really
 * produces?
 *
 * Run: npx tsx scripts/cellMeansEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { rmse, spearman } from "../src/backtest/metrics.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import { fitGbm, predictGbm } from "../src/backtest/gbm.js";
import {
  FIT_DEFAULTS, fitFactorization, predict as predictFactor,
} from "../src/model/factorization.js";
import {
  NET_DEFAULTS, fitEntityNet, predict as predictNet, type Task,
} from "../src/model/entityNet.js";

const distanceBand = (toGo: number) =>
  toGo <= 2 ? "short" : toGo <= 6 ? "medium" : toGo <= 10 ? "long" : "veryLong";

const fieldBand = (yardline: number) =>
  yardline <= 10 ? "goalLine" : yardline <= 25 ? "redZone"
    : yardline <= 50 ? "theirHalf" : "ownHalf";

async function main(): Promise<void> {
  const rows = parseCsv(
    await readFile(join(import.meta.dirname, "..", "data", "curated", "plays.csv"), "utf8"),
  ).filter((r) => ["run", "pass"].includes(r["playType"] ?? "") && r["grouping"] && r["shell"]);

  const all = rows.map((r) => {
    const box = Number(r["box"]) || 6;
    return {
      season: Number(r["season"]),
      yards: Number(r["yards"]),
      config: [
        r["playType"], r["grouping"], r["shell"], `d${r["down"]}`,
        distanceBand(Number(r["togo"])), fieldBand(Number(r["yardline"])),
      ].join(", "),
      words: [
        `type:${r["playType"]}`, `set:${r["grouping"]}`, `shell:${r["shell"]}`,
        `down:${r["down"]}`, `togo:${distanceBand(Number(r["togo"]))}`,
        `field:${fieldBand(Number(r["yardline"]))}`, `box:${Math.round(box)}`,
      ],
      numbers: [
        1,
        r["playType"] === "run" ? 1 : 0,
        r["grouping"] === "11" ? 1 : 0,
        r["grouping"] === "12" ? 1 : 0,
        r["grouping"] === "heavy" ? 1 : 0,
        r["shell"] === "base" ? 1 : 0,
        r["shell"] === "nickel" ? 1 : 0,
        Number(r["down"]) === 1 ? 1 : 0,
        Number(r["down"]) === 3 ? 1 : 0,
        Number(r["down"]) === 4 ? 1 : 0,
        Math.min(Number(r["togo"]), 25) / 10,
        Number(r["yardline"]) / 100,
        Number(r["yardline"]) <= 10 ? 1 : 0,
        box,
      ],
    };
  });

  const train = all.filter((e) => e.season < 2025);
  const test = all.filter((e) => e.season === 2025);
  console.log(`${train.length} plays to learn from, ${test.length} to score on\n`);

  const ridge = fitRidge(train.map((e) => e.numbers), train.map((e) => e.yards), 5);
  const trees = fitGbm(
    train.map((e) => e.numbers.slice(1)), train.map((e) => e.yards),
    { trees: 120, depth: 4, rate: 0.08, minLeaf: 60 },
  );
  const factored = fitFactorization(
    train.map((e) => ({ features: e.words, target: e.yards })),
    { ...FIT_DEFAULTS, passes: 6 },
  );
  const net = fitEntityNet(
    train.map((e) => e.words),
    [{ name: "yards", of: (i: number) => train[i]!.yards } as Task],
    { ...NET_DEFAULTS, passes: 6 },
  );

  const said = {
    "adding the pieces up": (e: (typeof all)[number]) => predictRidge(ridge, e.numbers),
    "trees": (e: (typeof all)[number]) => predictGbm(trees, e.numbers.slice(1)),
    "factorized": (e: (typeof all)[number]) => predictFactor(factored, e.words),
    "a network": (e: (typeof all)[number]) => predictNet(net, e.words, "yards"),
  };

  // what each configuration really averaged, and what each model said
  const cells = new Map<string, { yards: number[]; guess: Record<string, number> }>();

  for (const play of test) {
    const cell = cells.get(play.config) ??
      { yards: [], guess: {} as Record<string, number> };
    cell.yards.push(play.yards);
    for (const [name, get] of Object.entries(said)) cell.guess[name] = get(play);
    cells.set(play.config, cell);
  }

  const big = [...cells.values()].filter((c) => c.yards.length >= 100);
  const truth = big.map((c) => c.yards.reduce((a, b) => a + b, 0) / c.yards.length);
  const middle = truth.reduce((a, b) => a + b, 0) / truth.length;
  const spread = Math.sqrt(
    truth.reduce((a, b) => a + (b - middle) ** 2, 0) / truth.length,
  );

  console.log(`${big.length} configurations seen a hundred times or more`);
  console.log(`they average ${middle.toFixed(2)} yards and spread ${spread.toFixed(2)}\n`);
  console.log("model                       on cells          on single plays");
  console.log("                          rmse   rank         rmse   rank");

  for (const [name, get] of Object.entries(said)) {
    const onCells = big.map((c) => c.guess[name]!);
    const onPlays = test.map(get);
    console.log(
      "  " + name.padEnd(24) +
      rmse(onCells, truth).toFixed(2).padStart(6) +
      spearman(onCells, truth).toFixed(3).padStart(8) +
      rmse(onPlays, test.map((e) => e.yards)).toFixed(2).padStart(13) +
      spearman(onPlays, test.map((e) => e.yards)).toFixed(3).padStart(8),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
