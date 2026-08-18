/**
 * How far downfield a throw goes, by where it is called from.
 *
 * Whether a run goes inside swings twenty-three points on the
 * situation, so the same question is worth asking of a throw before
 * any of it is credited to the man catching it.
 *
 * Run: npx tsx scripts/passSituationCheck.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

interface Thrown {
  down: number;
  toGo: number;
  yardline: number;
  depth: number;
}

async function main(): Promise<void> {
  const rows = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
  ));
  const thrown: Thrown[] = [];

  for (const row of rows) {
    if (row["playType"] !== "pass" || row["airYards"] === "") {
      continue;
    }

    const depth = Number(row["airYards"]);

    if (!Number.isFinite(depth)) {
      continue;
    }

    thrown.push({
      down: Number(row["down"]), toGo: Number(row["togo"]),
      yardline: Number(row["yardline"]), depth,
    });
  }

  console.log("how far downfield a throw goes, by where it is called from\n");
  console.log("  situation                   throws   average depth   past fifteen");

  for (const [label, is] of [
    ["third and one", (t: Thrown) => t.down === 3 && t.toGo <= 1],
    ["third and two to six", (t: Thrown) => t.down === 3 && t.toGo >= 2 && t.toGo <= 6],
    ["third and ten plus", (t: Thrown) => t.down === 3 && t.toGo >= 10],
    ["first and ten, open field", (t: Thrown) =>
      t.down === 1 && t.toGo === 10 && t.yardline > 20 && t.yardline < 80],
    ["inside their ten", (t: Thrown) => t.yardline <= 10],
    ["backed up inside his five", (t: Thrown) => t.yardline >= 95],
  ] as [string, (t: Thrown) => boolean][]) {
    const these = thrown.filter(is);

    if (these.length < 200) {
      continue;
    }

    const deep = these.filter((t) => t.depth >= 15).length;
    console.log(
      "  " + label.padEnd(28) + String(these.length).padStart(6) +
        middle(these.map((t) => t.depth)).toFixed(2).padStart(16) +
        `${(100 * deep / these.length).toFixed(1)}%`.padStart(15),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
