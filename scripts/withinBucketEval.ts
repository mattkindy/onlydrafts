/**
 * What the four situations throw away.
 *
 * Everything downstream averages inside a bucket, so if the state still
 * moves things once the bucket is fixed, that movement is lost. Near
 * the goal covers everything inside the twenty, and third and long
 * covers seven to go and twenty to go alike.
 *
 * Run: npx tsx scripts/withinBucketEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { loadPlayerStats } from "../src/data/nflverse.js";

const SEASONS = [2022, 2023, 2024, 2025];

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

async function main(): Promise<void> {
  const position = new Map<string, string>();

  for (const season of SEASONS) {
    for (const s of await loadPlayerStats(season)) {
      position.set(s.playerId, s.position);
    }
  }

  const rows = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
  )).filter((r) => SEASONS.includes(Number(r["season"])));

  console.log(`${rows.length} touches\n`);

  const shareIn = (keep: (r: Record<string, string>) => boolean) => {
    const at = rows.filter(keep);

    if (at.length < 200) {
      return null;
    }

    const counts = new Map<string, number>();

    for (const row of at) {
      const spot = position.get(row["player"] ?? "") ?? "?";
      counts.set(spot, (counts.get(spot) ?? 0) + 1);
    }

    return {
      rb: (counts.get("RB") ?? 0) / at.length,
      wr: (counts.get("WR") ?? 0) / at.length,
      te: (counts.get("TE") ?? 0) / at.length,
      score: middle(at.map((r) => Number(r["touchdown"]) || 0)),
      yards: middle(at.map((r) => Number(r["yards"]) || 0)),
      n: at.length,
    };
  };

  console.log("inside the twenty, which our model calls one situation");
  console.log("  from the      backs   receivers   ends   scores   yards    plays");

  for (const [label, low, high] of [
    ["one or two", 1, 3], ["three to five", 3, 6], ["six to ten", 6, 11],
    ["eleven to fifteen", 11, 16], ["sixteen to twenty", 16, 21],
  ] as [string, number, number][]) {
    const out = shareIn((r) => {
      const yard = Number(r["yardline"]);
      return yard >= low && yard < high;
    });

    if (!out) continue;
    console.log(
      "  " + label.padEnd(14) +
      `${(100 * out.rb).toFixed(0)}%`.padStart(6) +
      `${(100 * out.wr).toFixed(0)}%`.padStart(11) +
      `${(100 * out.te).toFixed(0)}%`.padStart(7) +
      `${(100 * out.score).toFixed(1)}%`.padStart(9) +
      out.yards.toFixed(1).padStart(8) +
      String(out.n).padStart(9),
    );
  }

  console.log("\nthird down and seven or more, which is one situation too");
  console.log("  to go         backs   receivers   ends   yards    plays");

  for (const [label, low, high] of [
    ["seven or eight", 7, 9], ["nine or ten", 9, 11],
    ["eleven to fifteen", 11, 16], ["sixteen and up", 16, 60],
  ] as [string, number, number][]) {
    const out = shareIn((r) => {
      const togo = Number(r["togo"]);
      return Number(r["down"]) === 3 && togo >= low && togo < high;
    });

    if (!out) continue;
    console.log(
      "  " + label.padEnd(14) +
      `${(100 * out.rb).toFixed(0)}%`.padStart(6) +
      `${(100 * out.wr).toFixed(0)}%`.padStart(11) +
      `${(100 * out.te).toFixed(0)}%`.padStart(7) +
      out.yards.toFixed(1).padStart(8) +
      String(out.n).padStart(9),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
