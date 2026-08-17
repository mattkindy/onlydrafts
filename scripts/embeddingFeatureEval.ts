/**
 * The factorized model loses on any one question and describes the
 * entities on a play in a way an additive model cannot. So use it for
 * the second thing: fit the vectors, then hand them to the ridge as
 * ordinary columns and see whether the ridge improves.
 *
 * If it does, the generality pays without anyone paying for the
 * interaction search at prediction time.
 *
 * Run: npx tsx scripts/embeddingFeatureEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { loadCoaches } from "../src/data/coaches.js";
import { rmse, spearman } from "../src/backtest/metrics.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import {
  FIT_DEFAULTS, fitFactorization, type Example,
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

  const featuresOf = (r: Record<string, string>, season: number) => {
    const offense = r["offense"] ?? "";
    return [
      `offence:${offense}`,
      `defence:${r["defense"]}`,
      `caller:${coaches.get(`${offense}|${season}|OC`) ?? "unknown"}`,
      `down:${r["down"]}`,
      `togo:${distanceBand(Number(r["togo"]))}`,
      `field:${fieldBand(Number(r["yardline"]))}`,
      `grouping:${r["grouping"]}`,
      `shell:${r["shell"] || "unknown"}`,
      `type:${r["playType"]}`,
    ];
  };

  const all = rows.map((r) => {
    const season = Number(r["season"]);
    return { season, target: Number(r["yards"]), features: featuresOf(r, season) };
  });
  const train = all.filter((e) => e.season < 2025);
  const test = all.filter((e) => e.season === 2025);

  console.log(`${train.length} plays to learn from, ${test.length} to score on\n`);

  // the vectors, learned once on the training years
  console.time("learning the vectors");
  const learned = fitFactorization(train as Example[], { ...FIT_DEFAULTS, passes: 8 });
  console.timeEnd("learning the vectors");

  const keys = [...new Set(train.flatMap((e) => e.features))].sort();
  const index = new Map(keys.map((k, i) => [k, i]));

  /** the plain one-hot columns every version starts from */
  const oneHot = (features: string[]) => {
    const row = new Array(keys.length + 1).fill(0);
    row[0] = 1;
    for (const f of features) {
      const at = index.get(f);
      if (at !== undefined) row[at + 1] = 1;
    }
    return row;
  };

  /** and the same, with each entity's vector added on the end */
  const withVectors = (features: string[]) => {
    const row = oneHot(features);
    const summed = new Float64Array(learned.rank);
    const products = new Float64Array(learned.rank);

    for (const f of features) {
      const vector = learned.vector.get(f);
      if (!vector) continue;
      for (let k = 0; k < learned.rank; k++) {
        summed[k] = summed[k]! + vector[k]!;
      }
    }

    // the squared sums are what carry the pairings into a linear fit
    for (let k = 0; k < learned.rank; k++) {
      products[k] = summed[k]! * summed[k]!;
    }

    return [...row, ...summed, ...products];
  };

  const actual = test.map((e) => e.target);
  console.log("\npredicting the yards a play gains\n");
  console.log("  columns given to the ridge          rmse   spearman");

  for (const [label, build] of [
    ["one per entity", oneHot],
    ["and the learned vectors too", withVectors],
  ] as [string, (f: string[]) => number[]][]) {
    const weights = fitRidge(
      train.map((e) => build(e.features)), train.map((e) => e.target), 5,
    );
    const guess = test.map((e) => predictRidge(weights, build(e.features)));
    console.log(
      "  " + label.padEnd(32) + rmse(guess, actual).toFixed(3).padStart(8) +
      spearman(guess, actual).toFixed(3).padStart(11),
    );
  }

  // the other half of the exploit: a vector describes an entity, so it
  // can say which offences resemble each other without anyone scoring
  // them on anything in particular
  const near = (kind: string, of: string) => {
    const mine = learned.vector.get(`${kind}:${of}`);
    if (!mine) return [];
    const scored: [string, number][] = [];

    for (const [key, vector] of learned.vector) {
      if (!key.startsWith(kind + ":") || key === `${kind}:${of}`) continue;
      let dot = 0, mineLength = 0, theirs = 0;
      for (let k = 0; k < learned.rank; k++) {
        dot += mine[k]! * vector[k]!;
        mineLength += mine[k]! * mine[k]!;
        theirs += vector[k]! * vector[k]!;
      }
      scored.push([key.slice(kind.length + 1), dot / Math.sqrt(mineLength * theirs)]);
    }

    return scored.sort((a, b) => b[1] - a[1]).slice(0, 3);
  };

  console.log("\nwhich offences a vector says are alike\n");

  for (const team of ["BAL", "KC", "PHI"]) {
    console.log("  " + team + " is nearest " +
      near("offence", team).map(([t, v]) => t + " " + v.toFixed(2)).join(", "));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
