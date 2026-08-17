/**
 * A man's last so many games against a season of them.
 *
 * A season boundary means nothing to a player. Describing him from the
 * games behind him instead should say more in week six, and should say
 * at least as much in August, when the two are nearly the same thing.
 *
 * Run: npx tsx scripts/rollingWindowEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { spearman } from "../src/backtest/metrics.js";
import { ATTRIBUTES, buildPlayerVectors, buildRollingVectors } from "../src/features/playerVector.js";
import { loadPlayerStats } from "../src/data/nflverse.js";

const noise = (n: number) => 1 / Math.sqrt(Math.max(2, n - 1));

/** what each man did from a given week onward, per touch */
async function fromWeek(season: number, week: number) {
  const rows = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
  )).filter((r) =>
    Number(r["season"]) === season && Number(r["week"]) >= week && r["player"]);
  const tally = new Map<string, { touches: number; yards: number; long: number }>();

  for (const row of rows) {
    const own = tally.get(row["player"]!) ?? { touches: 0, yards: 0, long: 0 };
    const gained = Number(row["yards"]) || 0;
    own.touches++;
    own.yards += gained;
    if (gained >= 20) own.long++;
    tally.set(row["player"]!, own);
  }

  return tally;
}

async function main(): Promise<void> {
  const position = new Map<string, string>();

  for (const s of await loadPlayerStats(2025)) {
    position.set(s.playerId, s.position);
  }

  const at = ATTRIBUTES.indexOf("yardsPerCatch");
  console.log("guessing what a man does from a week on, by how he is described\n");
  console.log("  from week   a season of him   his last 17 games   men");

  for (const week of [1, 6, 10, 14]) {
    const rest = await fromWeek(2025, week);
    const bySeason = week === 1
      ? await buildPlayerVectors(2024)
      : await buildPlayerVectors(2025, week - 1);
    const rolling = await buildRollingVectors({ season: 2025, week });

    const men = [...rest].filter(([player, own]) =>
      own.touches >= 25 && bySeason.has(player) && rolling.has(player) &&
      ["RB", "WR", "TE"].includes(position.get(player) ?? ""));

    if (men.length < 30) {
      continue;
    }

    const truth = men.map(([, own]) => own.yards / own.touches);
    const fromSeason = men.map(([player]) => bySeason.get(player)!.values[at]!);
    const fromRolling = men.map(([player]) => rolling.get(player)!.values[at]!);

    console.log(
      "  " + String(week).padEnd(12) +
      spearman(fromSeason, truth).toFixed(3).padStart(11) +
      spearman(fromRolling, truth).toFixed(3).padStart(19) +
      String(men.length).padStart(7),
    );
  }

  console.log(`\n  give or take about ${noise(120).toFixed(3)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
