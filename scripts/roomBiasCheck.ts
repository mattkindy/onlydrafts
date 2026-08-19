/**
 * What the room filter actually selects.
 *
 * Drawing a gain only from plays that had room to run that far costs
 * three points of punt rate, and the reason given for it was that
 * those plays come from deeper field position where sides call more
 * conservatively. That was asserted rather than measured. This asks
 * what the kept plays and the dropped ones look like.
 *
 * Run: npx tsx scripts/roomBiasCheck.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

interface Play {
  yardline: number;
  call: string;
  yards: number;
}

async function main(): Promise<void> {
  const plays: Play[] = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
  ))
    .filter((r) => Number(r["season"]) < 2025)
    .map((r) => ({
      yardline: Number(r["yardline"]),
      call: r["playType"] ?? "",
      yards: Number(r["yards"]) || 0,
    }))
    .filter((p) => Number.isFinite(p.yardline) && ["run", "pass"].includes(p.call));

  console.log(`${plays.length} plays\n`);
  console.log(
    "asked about a play this far out, what the kept plays look like " +
      "against all of them\n",
  );
  console.log(
    "  from the       kept    dropped     runs kept v all     yards kept v all",
  );

  for (const yardline of [20, 40, 60, 75, 90]) {
    const kept = plays.filter((p) => p.yardline >= yardline);
    const dropped = plays.filter((p) => p.yardline < yardline);

    if (kept.length < 500) {
      continue;
    }

    const runs = (of: Play[]) =>
      of.filter((p) => p.call === "run").length / Math.max(1, of.length);
    console.log(
      `  ${String(yardline).padStart(2)}   ` +
        String(kept.length).padStart(10) +
        String(dropped.length).padStart(11) +
        `   ${(100 * runs(kept)).toFixed(0)}% v ${(100 * runs(plays)).toFixed(0)}%`.padStart(20) +
        `   ${middle(kept.map((p) => p.yards)).toFixed(2)} v ` +
        `${middle(plays.map((p) => p.yards)).toFixed(2)}`,
    );
  }

  // and the thing the filter is meant to fix: how often a gain is
  // long, among plays that had the room for one
  console.log("\nhow often a play gains twenty or more\n");
  console.log("  from the      all plays   only those with the room");

  for (const yardline of [20, 40, 60, 75, 90]) {
    const kept = plays.filter((p) => p.yardline >= yardline);

    if (kept.length < 500) {
      continue;
    }

    const long = (of: Play[]) =>
      of.filter((p) => p.yards >= 20).length / Math.max(1, of.length);
    console.log(
      `  ${String(yardline).padStart(2)}   ` +
        `${(100 * long(plays)).toFixed(1)}%`.padStart(13) +
        `${(100 * long(kept)).toFixed(1)}%`.padStart(27),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
