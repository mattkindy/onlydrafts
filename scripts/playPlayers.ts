/**
 * The player eval over every core, one season at a time.
 *
 * gamePlayerEval plays the season serially, which is most of an hour
 * for three seasons. The games do not depend on each other, so each
 * share of the schedule runs in its own process, the totals merge,
 * and the scoring runs once on the merged answer.
 *
 * Run: npx tsx scripts/playPlayers.ts 2025 2024 2023
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { acrossCores, roomFor } from "../src/sim/acrossCores.js";
import { buildMatchupTable } from "../src/features/matchupTable.js";

async function oneSeason(season: number): Promise<void> {
  console.log(`\n===== ${season} =====`);
  // counted once here so the eight shares read the disk rather than
  // each counting the same rows in a race
  spawnSync("npx", ["tsx", join(import.meta.dirname, "gamePlayerEval.ts")], {
    env: {
      ...process.env, SEASON: String(season), SHARES: "on", PREWARM: "on",
      NODE_OPTIONS: "--max-old-space-size=8192",
    },
    encoding: "utf8",
  });
  await buildMatchupTable({
    learn: [season - 3, season - 2, season - 1].filter((s) => s >= 2022),
    scoreOn: season,
  });
  const printed = await acrossCores({
    script: join(import.meta.dirname, "gamePlayerEval.ts"),
    shares: Math.min(8, roomFor()),
    env: {
      SEASON: String(season), SHARES: "on",
      NODE_OPTIONS: "--max-old-space-size=6144",
    },
    asTheyLand: (share) => console.error(`  share ${share} back`),
  });

  const total = new Map<string, number>();
  const games = new Map<string, number>();

  for (const line of printed) {
    const from = JSON.parse(line) as {
      total: [string, number][]; games: [string, number][];
    };

    for (const [playerId, points] of from.total) {
      total.set(playerId, (total.get(playerId) ?? 0) + points);
    }

    for (const [playerId, n] of from.games) {
      games.set(playerId, (games.get(playerId) ?? 0) + n);
    }
  }

  const at = join(
    import.meta.dirname, "..", "data", "kept", `played-${season}.json`,
  );
  await writeFile(at, JSON.stringify({
    total: [...total.entries()], games: [...games.entries()],
  }));

  // the scoring pass, which needs no simulating
  const scored = spawnSync("npx", ["tsx", join(import.meta.dirname, "gamePlayerEval.ts")], {
    env: { ...process.env, SEASON: String(season), MERGED: at },
    encoding: "utf8",
  });
  console.log(scored.stdout);

  if (scored.status !== 0) {
    console.error(scored.stderr.slice(-500));
  }
}

async function main(): Promise<void> {
  const seasons = process.argv.slice(2).map(Number).filter(Number.isFinite);

  for (const season of seasons.length ? seasons : [2025]) {
    await oneSeason(season);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
