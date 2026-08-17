/**
 * A single play's yards was never predictable, because the play call
 * is not in the data. What is in the data is who lined up where, and
 * what a simulator needs is the average such a configuration produces.
 *
 * So group the held-out plays by configuration, take the average each
 * one really produced, and ask how close the model got to that rather
 * than to any single snap.
 *
 * Run: npx tsx scripts/expectedYardsEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { rmse, spearman } from "../src/backtest/metrics.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";

const distanceBand = (toGo: number) =>
  toGo <= 2 ? "short" : toGo <= 6 ? "medium" : toGo <= 10 ? "long" : "veryLong";

const fieldBand = (yardline: number) =>
  yardline <= 10 ? "goalLine" : yardline <= 25 ? "redZone"
    : yardline <= 50 ? "theirHalf" : "ownHalf";

async function main(): Promise<void> {
  const rows = parseCsv(
    await readFile(join(import.meta.dirname, "..", "data", "curated", "plays.csv"), "utf8"),
  ).filter((r) => ["run", "pass"].includes(r["playType"] ?? "") && r["grouping"] && r["shell"]);

  const configOf = (r: Record<string, string>) => [
    r["playType"], r["grouping"], r["shell"],
    `d${r["down"]}`, distanceBand(Number(r["togo"])), fieldBand(Number(r["yardline"])),
  ].join("|");

  const all = rows.map((r) => ({
    season: Number(r["season"]),
    config: configOf(r),
    yards: Number(r["yards"]),
    features: [
      1,
      r["playType"] === "run" ? 1 : 0,
      r["grouping"] === "11" ? 1 : 0,
      r["grouping"] === "12" ? 1 : 0,
      r["grouping"] === "heavy" ? 1 : 0,
      r["shell"] === "base" ? 1 : 0,
      r["shell"] === "nickel" ? 1 : 0,
      r["shell"] === "dime" ? 1 : 0,
      Number(r["down"]) === 1 ? 1 : 0,
      Number(r["down"]) === 3 ? 1 : 0,
      Number(r["down"]) === 4 ? 1 : 0,
      Math.min(Number(r["togo"]), 25) / 10,
      Number(r["yardline"]) / 100,
      Number(r["yardline"]) <= 10 ? 1 : 0,
      Number(r["box"]) || 6,
      // the pairings a simulator cares about
      (r["grouping"] === "heavy" ? 1 : 0) * (r["shell"] === "base" ? 1 : 0),
      (r["grouping"] === "11" ? 1 : 0) * (r["shell"] === "dime" ? 1 : 0),
      (r["playType"] === "run" ? 1 : 0) * (Number(r["box"]) || 6),
    ],
  }));

  const train = all.filter((e) => e.season < 2025);
  const test = all.filter((e) => e.season === 2025);
  const weights = fitRidge(train.map((e) => e.features), train.map((e) => e.yards), 5);

  console.log(`${train.length} plays to learn from, ${test.length} to score on\n`);

  // what each configuration really averaged, in the season nobody saw
  const cells = new Map<string, { yards: number[]; said: number }>();

  for (const play of test) {
    const cell = cells.get(play.config) ?? { yards: [], said: 0 };
    cell.yards.push(play.yards);
    cell.said = predictRidge(weights, play.features);
    cells.set(play.config, cell);
  }

  console.log("how close the model gets to what a configuration averages\n");
  console.log("  cells of at least   n   spearman    rmse   spread of the truth");

  for (const enough of [20, 50, 150, 400]) {
    const big = [...cells.values()].filter((c) => c.yards.length >= enough);

    if (big.length < 8) {
      continue;
    }

    const truth = big.map((c) => c.yards.reduce((a, b) => a + b, 0) / c.yards.length);
    const said = big.map((c) => c.said);
    const middle = truth.reduce((a, b) => a + b, 0) / truth.length;
    const spread = Math.sqrt(
      truth.reduce((a, b) => a + (b - middle) ** 2, 0) / truth.length,
    );

    console.log(
      "  " + String(enough).padStart(15) + String(big.length).padStart(5) +
      spearman(said, truth).toFixed(3).padStart(11) +
      rmse(said, truth).toFixed(2).padStart(8) +
      spread.toFixed(2).padStart(16),
    );
  }

  console.log("\nfor comparison, against single plays rather than cells:");
  console.log("  spearman " +
    spearman(test.map((e) => predictRidge(weights, e.features)), test.map((e) => e.yards))
      .toFixed(3) +
    "   rmse " +
    rmse(test.map((e) => predictRidge(weights, e.features)), test.map((e) => e.yards))
      .toFixed(2));

  // and the cells a simulator would lean on hardest
  const busiest = [...cells.entries()]
    .filter(([, c]) => c.yards.length >= 200)
    .sort((a, b) => b[1].yards.length - a[1].yards.length)
    .slice(0, 6);

  console.log("\nthe configurations it sees most\n");
  console.log("  play, personnel, shell, down, distance, field      n    said   really");

  for (const [config, cell] of busiest) {
    const truth = cell.yards.reduce((a, b) => a + b, 0) / cell.yards.length;
    console.log(
      "  " + config.replace(/\|/g, ", ").padEnd(48) +
      String(cell.yards.length).padStart(5) +
      cell.said.toFixed(2).padStart(8) + truth.toFixed(2).padStart(9),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
