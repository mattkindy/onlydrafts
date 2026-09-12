/**
 * Every game of a season stopped at six snaps, cached so the live
 * remainder eval does not read 98 MB of play by play on each run.
 *
 * Run: npx tsx scripts/aggregateCheckpoints.ts [seasons]
 */

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RAW_DIR } from "../src/data/nflverse.js";
import { cacheHeader, cacheRows, seasonCheckpoints } from "../src/backtest/checkpoints.js";

const SEASONS = (process.argv[2] ?? "2024,2025").split(",").map(Number);

for (const season of SEASONS) {
  const path = join(RAW_DIR, `play_by_play_${season}.csv`);

  if (!existsSync(path)) {
    console.log(`missing ${path}, skipping`);
    continue;
  }

  const rows = [cacheHeader()];
  let games = 0;
  let stops = 0;
  let lastGame = "";

  for await (const one of seasonCheckpoints(path)) {
    if (one.gameId !== lastGame) {
      lastGame = one.gameId;
      games++;
    }

    stops++;
    rows.push(...cacheRows(one));
  }

  const out = join(RAW_DIR, "..", "curated", `checkpoints-${season}.csv`);
  await writeFile(out, rows.join("\n") + "\n");
  console.log(`${season}: ${games} games, ${stops} checkpoints, ${rows.length - 1} rows`);
}
