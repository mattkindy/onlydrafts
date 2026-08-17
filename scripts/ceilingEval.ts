/**
 * A man who has shown a level has proved he can reach it, whatever his
 * average settles at. So the question the last test could not answer
 * may still have one: does what he showed predict his ceiling, once
 * his average is already accounted for?
 *
 * Run: npx tsx scripts/ceilingEval.ts
 */

import { loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { spearman } from "../src/backtest/metrics.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";

const SEASONS = [2021, 2022, 2023, 2024, 2025];

interface Year {
  id: string; season: number; position: string;
  whole: number;
  /** the best stretch of five he put together */
  bestRun: number;
  /** his ninetieth week and the share of weeks over twenty */
  ceiling: number;
  bigWeeks: number;
}

function describe(points: number[]): Omit<Year, "id" | "season" | "position"> {
  const sorted = [...points].sort((a, b) => a - b);
  let bestRun = 0;

  for (let i = 0; i + 5 <= points.length; i++) {
    const run = points.slice(i, i + 5).reduce((a, b) => a + b, 0) / 5;
    if (run > bestRun) bestRun = run;
  }

  return {
    whole: points.reduce((a, b) => a + b, 0) / points.length,
    bestRun,
    ceiling: sorted[Math.floor(sorted.length * 0.9)]!,
    bigWeeks: points.filter((p) => p >= 20).length / points.length,
  };
}

async function main(): Promise<void> {
  const years: Year[] = [];

  for (const season of SEASONS) {
    const byPlayer = new Map<string, { position: string; points: number[] }>();

    for (const row of await loadPlayerStats(season)) {
      if (row.week > 18 || !["RB", "WR", "TE"].includes(row.position)) continue;
      const own = byPlayer.get(row.playerId) ?? { position: row.position, points: [] };
      own.points.push(fantasyPoints(row.statLine, presets.standard));
      byPlayer.set(row.playerId, own);
    }

    for (const [id, own] of byPlayer) {
      if (own.points.length < 12) continue;
      years.push({ id, season, position: own.position, ...describe(own.points) });
    }
  }

  const byKey = new Map(years.map((y) => [`${y.id}|${y.season}`, y]));
  const pairs: { before: Year; after: Year }[] = [];

  for (const year of years) {
    const before = byKey.get(`${year.id}|${year.season - 1}`);
    if (before) pairs.push({ before, after: year });
  }

  console.log(`${pairs.length} pairs\n`);
  console.log("predicting next season's ceiling, his ninetieth week\n");
  console.log("  from                          spearman");

  const target = pairs.map((p) => p.after.ceiling);

  for (const [label, get] of [
    ["his average", (y: Year) => y.whole],
    ["his own ceiling", (y: Year) => y.ceiling],
    ["his best five week run", (y: Year) => y.bestRun],
    ["how often he went over twenty", (y: Year) => y.bigWeeks],
  ] as [string, (y: Year) => number][]) {
    console.log("  " + label.padEnd(32) +
      spearman(pairs.map((p) => get(p.before)), target).toFixed(3).padStart(8));
  }

  // the question that matters: does the best run say anything the
  // average has not already said?
  const train = pairs.filter((p) => p.after.season < 2025);
  const test = pairs.filter((p) => p.after.season === 2025);
  const onlyAverage = (y: Year) => [1, y.whole];
  const alsoRun = (y: Year) => [1, y.whole, y.bestRun, y.ceiling];

  console.log("\n  trained on earlier seasons, scored on 2025 (" + test.length + " men)\n");
  console.log("  predicting                       average only   with what he showed");

  for (const [label, of] of [
    ["his ceiling next season", (y: Year) => y.ceiling],
    ["how often he goes over twenty", (y: Year) => y.bigWeeks],
    ["his average next season", (y: Year) => y.whole],
  ] as [string, (y: Year) => number][]) {
    const plain = fitRidge(train.map((p) => onlyAverage(p.before)), train.map((p) => of(p.after)), 1);
    const richer = fitRidge(train.map((p) => alsoRun(p.before)), train.map((p) => of(p.after)), 1);
    const truth = test.map((p) => of(p.after));

    console.log(
      "  " + label.padEnd(34) +
      spearman(test.map((p) => predictRidge(plain, onlyAverage(p.before))), truth)
        .toFixed(3).padStart(9) +
      spearman(test.map((p) => predictRidge(richer, alsoRun(p.before))), truth)
        .toFixed(3).padStart(18),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
