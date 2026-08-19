/**
 * Where a drive starts, drawn against where they really start.
 *
 * The walk reaches fourth down a yard and a half further from the goal
 * than sides do, while gaining more per play over the same number of
 * plays. Those cannot both be true unless it starts further back.
 *
 * Run: npx tsx scripts/driveStartCheck.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { loadDriveStarts, startFrom } from "../src/features/driveStarts.js";
import { seededRng } from "../src/sim/rng.js";

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

const half = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

async function main(): Promise<void> {
  const starts = await loadDriveStarts([2022, 2023, 2024]);
  const rng = seededRng(7);
  const drawn = Array.from({ length: 30000 }, () => startFrom(starts, rng));

  const real = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "drives.csv"), "utf8",
  ))
    .filter((r) => [2022, 2023, 2024].includes(Number(r["season"])))
    .map((r) => Number(r["startYard"]))
    .filter((y) => Number.isFinite(y));

  console.log(
    "where a drive starts, in yards from the goal\n\n" +
      `  what the walk draws   average ${middle(drawn).toFixed(1)}   ` +
      `half inside ${half(drawn)}\n` +
      `  what the file says    average ${middle(real).toFixed(1)}   ` +
      `half inside ${half(real)}\n` +
      `  over ${real.length} drives in the seasons it learned from`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
