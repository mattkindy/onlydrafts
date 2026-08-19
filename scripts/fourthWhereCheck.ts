/**
 * Where a drive is when it reaches fourth down.
 *
 * The walk attempts kicks on 17.0% of drives where sides attempt
 * 18.4%, and loses the ball on downs 4.0% where they lose it 5.8%.
 * Both would follow if its drives stall further from the goal, since
 * from out there a side punts whatever it would rather do.
 *
 * Run: npx tsx scripts/fourthWhereCheck.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

async function main(): Promise<void> {
  const fourths = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "plays.csv"), "utf8",
  )).filter((r) => Number(r["down"]) === 4 && Number(r["season"]) === 2025);

  const where = fourths.map((r) => Number(r["yardline"])).filter(Number.isFinite);
  const sorted = [...where].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.floor(sorted.length * q)] ?? 0;

  console.log(
    `${where.length} fourth downs in 2025\n\n` +
      "  where a side stands on fourth down, in yards from the goal\n" +
      `    a tenth inside ${at(0.1)}, a quarter inside ${at(0.25)}, ` +
      `half inside ${at(0.5)},\n` +
      `    three quarters inside ${at(0.75)}, average ${middle(where).toFixed(1)}\n` +
      `    and ${(100 * where.filter((y) => y <= 40).length / where.length).toFixed(1)}% ` +
      "are inside the forty, where a kick is on",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
