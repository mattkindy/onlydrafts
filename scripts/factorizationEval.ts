/**
 * Fits the plays with nothing named in advance, then checks what it
 * found against what today's hand-run comparisons found.
 *
 * Those comparisons each took a hypothesis, a group-by and a rank
 * correlation, so they only ever answered questions somebody thought
 * to ask. If this recovers them without being told, it can be trusted
 * to find the ones nobody asked about.
 *
 * Run: npx tsx scripts/factorizationEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { loadCoaches } from "../src/data/coaches.js";
import { rmse, spearman } from "../src/backtest/metrics.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import {
  FIT_DEFAULTS, affinity, fitFactorization, predict, type Example,
} from "../src/model/factorization.js";

const distanceBand = (toGo: number) =>
  toGo <= 2 ? "short" : toGo <= 6 ? "medium" : toGo <= 10 ? "long" : "veryLong";

const fieldBand = (yardline: number) =>
  yardline <= 10 ? "goalLine" : yardline <= 25 ? "redZone"
    : yardline <= 50 ? "theirHalf" : yardline <= 80 ? "ownHalf" : "backedUp";

async function main(): Promise<void> {
  const coaches = await loadCoaches();
  const rows = parseCsv(
    await readFile(join(import.meta.dirname, "..", "data", "curated", "plays.csv"), "utf8"),
  ).filter((r) => ["run", "pass"].includes(r["playType"] ?? "") && r["grouping"]);

  const target = process.argv.includes("--heavy") ? "heavy" : "yards";

  const asExample = (r: Record<string, string>): Example & { season: number } => {
    const season = Number(r["season"]);
    const offense = r["offense"] ?? "";

    return {
      season,
      target: target === "yards"
        ? Number(r["yards"])
        : (r["grouping"] === "heavy" || r["grouping"] === "12" ? 1 : 0),
      features: [
        `offence:${offense}`,
        `defence:${r["defense"]}`,
        `caller:${coaches.get(`${offense}|${season}|OC`) ?? "unknown"}`,
        `boss:${coaches.get(`${offense}|${season}|HC`) ?? "unknown"}`,
        `down:${r["down"]}`,
        `togo:${distanceBand(Number(r["togo"]))}`,
        `field:${fieldBand(Number(r["yardline"]))}`,
        ...(target === "yards"
          ? [`grouping:${r["grouping"]}`, `shell:${r["shell"] || "unknown"}`]
          : []),
        `type:${r["playType"]}`,
      ],
    };
  };

  const all = rows.map(asExample);
  const train = all.filter((e) => e.season < 2025);
  const test = all.filter((e) => e.season === 2025);

  console.log(`${train.length} plays to learn from, ${test.length} to score on\n`);
  console.time("fitting");
  const model = fitFactorization(train, { ...FIT_DEFAULTS, passes: 8 });
  console.timeEnd("fitting");

  // a ridge on the same features, which can only add them up
  const keys = [...new Set(train.flatMap((e) => e.features))].sort();
  const index = new Map(keys.map((k, i) => [k, i]));
  const asRow = (e: Example) => {
    const row = new Array(keys.length + 1).fill(0);
    row[0] = 1;
    for (const f of e.features) {
      const at = index.get(f);
      if (at !== undefined) row[at + 1] = 1;
    }
    return row;
  };

  const weights = fitRidge(train.map(asRow), train.map((e) => e.target), 5);
  const actual = test.map((e) => e.target);

  console.log("\npredicting " +
      (target === "yards" ? "the yards a play gains" : "whether it is a tight end set") + "\n");
  console.log("  model                          rmse   spearman");
  console.log("  saying the average always" +
    rmse(actual.map(() => model.bias), actual).toFixed(3).padStart(12) +
    "      0.000");
  console.log("  adding the pieces up" +
    rmse(test.map((e) => predictRidge(weights, asRow(e))), actual).toFixed(3).padStart(17) +
    spearman(test.map((e) => predictRidge(weights, asRow(e))), actual).toFixed(3).padStart(11));
  console.log("  letting them combine" +
    rmse(test.map((e) => predict(model, e.features)), actual).toFixed(3).padStart(17) +
    spearman(test.map((e) => predict(model, e.features)), actual).toFixed(3).padStart(11));

  // now: did it find what the hand-run tests found?
  console.log("\nwhat it pulled together, without being told to look\n");

  const pairs: [string, string, string][] = target === "yards"
    ? [
      ["a heavy set near the goal", "grouping:heavy", "field:goalLine"],
      ["a heavy set on third and long", "grouping:heavy", "togo:veryLong"],
      ["a base defence against heavy", "shell:base", "grouping:heavy"],
      ["a run on fourth and short", "type:run", "down:4"],
    ]
    : [
      ["the goal line and a run", "field:goalLine", "type:run"],
      ["third and long and a pass", "togo:veryLong", "type:pass"],
      ["the goal line and third down", "field:goalLine", "down:3"],
      ["backed up and first down", "field:backedUp", "down:1"],
    ];

  for (const [label, left, right] of pairs) {
    console.log("  " + label.padEnd(36) + affinity(model, left, right).toFixed(3).padStart(8));
  }

  // and which offences it thinks are most unlike each other
  const offences = [...model.vector.keys()].filter((k) => k.startsWith("offence:"));
  const closest: [string, string, number][] = [];

  for (let i = 0; i < offences.length; i++) {
    for (let j = i + 1; j < offences.length; j++) {
      closest.push([offences[i]!, offences[j]!, affinity(model, offences[i]!, offences[j]!)]);
    }
  }

  closest.sort((a, b) => b[2] - a[2]);
  console.log("\noffences it puts closest together:");

  for (const [a, b, value] of closest.slice(0, 3)) {
    console.log("  " + a.slice(8) + " and " + b.slice(8) + "   " + value.toFixed(3));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
