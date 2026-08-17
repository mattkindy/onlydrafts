/**
 * What the published depth charts say, before anything is built on them.
 *
 * The share model works out where a man stands by ranking his team-mates
 * on what they did last season. The league publishes the answer.
 *
 * Run: npx tsx scripts/depthChartCheck.ts [season]
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { RAW_DIR } from "../src/data/nflverse.js";

const season = Number(process.argv[2] ?? 2025);

async function main(): Promise<void> {
  const rows = parseCsv(
    await readFile(join(RAW_DIR, `depth_charts_${season}.csv`), "utf8"),
  );
  console.log(`${rows.length} rows for ${season}`);

  const dates = [...new Set(rows.map((r) => (r["dt"] ?? "").slice(0, 10)))].sort();
  console.log(`${dates.length} dates, from ${dates[0]} to ${dates[dates.length - 1]}`);

  const groups = new Map<string, number>();

  for (const row of rows) {
    const key = row["pos_abb"] ?? "";
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }

  console.log(
    "positions: " +
      [...groups].sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([p, n]) => `${p} ${n}`).join(", "),
  );

  // one date early in the season, to see the shape of it
  const early = dates.find((d) => d >= `${season}-09-01`) ?? dates[0]!;
  const sample = rows.filter((r) =>
    (r["dt"] ?? "").startsWith(early) && r["team"] === "BUF" &&
    ["RB", "WR", "TE"].includes(r["pos_abb"] ?? ""));

  console.log(`\none team on ${early}:`);

  for (const row of sample.slice(0, 10)) {
    console.log(
      "  " + (row["pos_abb"] ?? "").padEnd(4) +
      (row["pos_slot"] ?? "").padEnd(4) +
      (row["pos_rank"] ?? "").padEnd(4) +
      (row["player_name"] ?? "") +
      (row["gsis_id"] ? "" : "   (no id)"),
    );
  }

  const withId = rows.filter((r) => (r["gsis_id"] ?? "").startsWith("00-")).length;
  console.log(
    `\n${(100 * withId / rows.length).toFixed(0)}% of rows carry a gsis id`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
