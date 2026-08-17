/**
 * Whether the participation release lists the players on each snap.
 *
 * The interaction layer needs the men actually on the field, not a
 * season-long roster average, so this reports how often those lists are
 * filled in and how many players they cover.
 *
 * Run: npx tsx scripts/participationCheck.ts [season]
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { RAW_DIR } from "../src/data/nflverse.js";

const season = Number(process.argv[2] ?? 2024);

async function main(): Promise<void> {
  const rows = parseCsv(
    await readFile(join(RAW_DIR, `participation_${season}.csv`), "utf8"),
  );
  const listed = rows.filter((r) => (r["offense_players"] ?? "").length > 5);
  console.log(
    `${season}: ${rows.length} plays, ${listed.length} with the offence listed ` +
      `(${(100 * listed.length / rows.length).toFixed(1)}%)`,
  );

  if (!listed.length) {
    return;
  }

  const one = listed[0]!;
  console.log("\none snap:");
  console.log("  offence   " + one["offense_players"]);
  console.log("  defence   " + (one["defense_players"] ?? "").slice(0, 100));
  console.log("  personnel " + one["offense_personnel"]);

  const counts = listed.slice(0, 20000)
    .map((r) => (r["offense_players"] ?? "").split(";").filter(Boolean).length);
  console.log(
    `\naverage listed per snap: ` +
      (counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(1),
  );

  const everyone = new Set<string>();
  for (const row of listed) {
    for (const id of (row["offense_players"] ?? "").split(";")) {
      if (id) everyone.add(id);
    }
  }
  console.log(`${everyone.size} different men appear on offence`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
