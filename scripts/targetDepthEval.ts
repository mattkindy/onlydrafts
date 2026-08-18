/**
 * How far downfield a throw goes, and what it does to the outcome.
 *
 * A pass is drawn from one pool for the situation, so a possession
 * receiver and a deep threat get the same throw. Depth is chosen
 * before anybody catches it and settles both halves at once: a deep
 * ball is far more likely to gain nothing and far better when it does
 * not. That is the thing a multiplier cannot say.
 *
 * So ask whether depth is a man's own, whether it lasts, and how much
 * of the outcome it explains.
 *
 * Run: npx tsx scripts/targetDepthEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { spearman } from "../src/backtest/metrics.js";

const noise = (n: number) => 1 / Math.sqrt(Math.max(2, n - 1));

interface Thrown {
  season: number;
  player: string;
  depth: number;
  yards: number;
  caught: boolean;
}

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

async function main(): Promise<void> {
  const rows = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
  ));
  const thrown: Thrown[] = [];

  for (const row of rows) {
    if (row["playType"] !== "pass" || !row["player"] || row["airYards"] === "") {
      continue;
    }

    const depth = Number(row["airYards"]);

    if (!Number.isFinite(depth)) {
      continue;
    }

    const yards = Number(row["yards"]) || 0;
    thrown.push({
      season: Number(row["season"]), player: row["player"]!,
      depth, yards, caught: yards > 0 || depth < 0,
    });
  }

  console.log(`${thrown.length} throws with a depth on them\n`);

  // what happens at each depth, which is the whole point
  const bands: [string, (d: number) => boolean][] = [
    ["behind the line", (d) => d < 0],
    ["at the line to 4", (d) => d >= 0 && d < 5],
    ["5 to 9", (d) => d >= 5 && d < 10],
    ["10 to 14", (d) => d >= 10 && d < 15],
    ["15 to 24", (d) => d >= 15 && d < 25],
    ["25 and beyond", (d) => d >= 25],
  ];

  console.log("what a throw does, by how far downfield it went\n");
  console.log(
    "  depth                 throws   gains nothing   yards a throw" +
      "   yards when it works",
  );

  for (const [label, is] of bands) {
    const these = thrown.filter((t) => is(t.depth));

    if (!these.length) {
      continue;
    }

    const nothing = these.filter((t) => t.yards <= 0);
    const worked = these.filter((t) => t.yards > 0);
    console.log(
      "  " + label.padEnd(22) + String(these.length).padStart(6) +
        `${(100 * nothing.length / these.length).toFixed(1)}%`.padStart(16) +
        middle(these.map((t) => t.yards)).toFixed(2).padStart(16) +
        middle(worked.map((t) => t.yards)).toFixed(2).padStart(22),
    );
  }

  // and whether a man's own depth is his, which is what would let the
  // walk choose one for him
  const bySeason = new Map<string, Map<number, number[]>>();

  for (const one of thrown) {
    const his = bySeason.get(one.player) ?? new Map<number, number[]>();
    his.set(one.season, [...(his.get(one.season) ?? []), one.depth]);
    bySeason.set(one.player, his);
  }

  const was: number[] = [];
  const now: number[] = [];

  for (const his of bySeason.values()) {
    for (const [season, depths] of his) {
      const after = his.get(season + 1);

      if (!after || depths.length < 30 || after.length < 30) {
        continue;
      }

      was.push(middle(depths));
      now.push(middle(after));
    }
  }

  console.log(
    `\nhis own depth from one season to the next, ${was.length} men` +
      `\n  ${spearman(was, now).toFixed(4)}, give or take ${noise(was.length).toFixed(3)}`,
  );

  // how much of the outcome depth accounts for, against the man
  const depths = thrown.map((t) => t.depth);
  const gains = thrown.map((t) => t.yards);
  const ownDepth = new Map<string, number>();

  for (const [player, his] of bySeason) {
    ownDepth.set(player, middle([...his.values()].flat()));
  }

  console.log(
    "\nordering what a throw gains\n" +
      `  by how far downfield it went   ${spearman(depths, gains).toFixed(4)}\n` +
      "  by whose throw it was          " +
      spearman(thrown.map((t) => ownDepth.get(t.player) ?? 0), gains).toFixed(4),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
