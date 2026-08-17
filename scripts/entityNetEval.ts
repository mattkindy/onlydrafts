/**
 * Does one set of descriptions, trained on four questions at once,
 * beat adding the pieces up on each question separately?
 *
 * That is the wager behind sharing them. Fitting yards alone gave each
 * entity one question's worth of evidence and lost to a ridge. Four
 * questions give the same vectors four times as much.
 *
 * Run: npx tsx scripts/entityNetEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { loadCoaches } from "../src/data/coaches.js";
import { rmse, spearman } from "../src/backtest/metrics.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import { NET_DEFAULTS, fitEntityNet, predict, type Task } from "../src/model/entityNet.js";

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

  // what the model may see: never the thing it is being asked
  const featuresOf = (r: Record<string, string>) => {
    const season = Number(r["season"]);
    const offense = r["offense"] ?? "";
    return [
      `offence:${offense}`,
      `defence:${r["defense"]}`,
      `caller:${coaches.get(`${offense}|${season}|OC`) ?? "unknown"}`,
      `down:${r["down"]}`,
      `togo:${distanceBand(Number(r["togo"]))}`,
      `field:${fieldBand(Number(r["yardline"]))}`,
    ];
  };

  const all = rows.map((r) => ({
    season: Number(r["season"]),
    features: featuresOf(r),
    yards: Number(r["yards"]),
    isRun: r["playType"] === "run" ? 1 : 0,
    isHeavy: r["grouping"] === "heavy" || r["grouping"] === "12" ? 1 : 0,
    firstDown: r["firstDown"] === "1" ? 1 : 0,
  }));

  const train = all.filter((e) => e.season < 2025);
  const test = all.filter((e) => e.season === 2025);
  console.log(`${train.length} plays to learn from, ${test.length} to score on\n`);

  const QUESTIONS = [
    ["the yards it gains", (e: (typeof all)[number]) => e.yards],
    ["whether it is a run", (e: (typeof all)[number]) => e.isRun],
    ["whether it is a tight end set", (e: (typeof all)[number]) => e.isHeavy],
    ["whether it moves the chains", (e: (typeof all)[number]) => e.firstDown],
  ] as [string, (e: (typeof all)[number]) => number][];

  console.time("learning one set of descriptions");
  const net = fitEntityNet(
    train.map((e) => e.features),
    QUESTIONS.map(([name, get]) => ({ name, of: (i: number) => get(train[i]!) }) as Task),
    { ...NET_DEFAULTS, passes: 6 },
  );
  console.timeEnd("learning one set of descriptions");

  const keys = [...new Set(train.flatMap((e) => e.features))].sort();
  const index = new Map(keys.map((k, i) => [k, i]));
  const asRow = (features: string[]) => {
    const row = new Array(keys.length + 1).fill(0);
    row[0] = 1;
    for (const f of features) {
      const at = index.get(f);
      if (at !== undefined) row[at + 1] = 1;
    }
    return row;
  };

  console.log("\n                                  adding up        shared");
  console.log("question                        rmse    rank    rmse    rank");

  for (const [name, get] of QUESTIONS) {
    const weights = fitRidge(
      train.map((e) => asRow(e.features)), train.map(get), 5,
    );
    const actual = test.map(get);
    const added = test.map((e) => predictRidge(weights, asRow(e.features)));
    const shared = test.map((e) => predict(net, e.features, name));

    console.log(
      name.padEnd(30) +
      rmse(added, actual).toFixed(3).padStart(7) +
      spearman(added, actual).toFixed(3).padStart(8) +
      rmse(shared, actual).toFixed(3).padStart(8) +
      spearman(shared, actual).toFixed(3).padStart(8),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
