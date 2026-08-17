/**
 * Targets against a defender, and what came of them, worked out from
 * who broke the pass up or who made the tackle.
 *
 * Nobody publishes who was covering whom without charting it. But on
 * an incompletion the play-by-play names whoever knocked it down, and
 * on a completion it names whoever brought him down, and for a
 * defensive back on a passing play that is usually the man in
 * coverage. It is a proxy and it will miss zone hand-offs and any
 * completion tackled by someone else.
 *
 * Run: npx tsx scripts/aggregateCoverage.ts
 */

import { createReadStream, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { RAW_DIR, loadWeeklyRosters } from "../src/data/nflverse.js";
import { splitLine } from "../src/data/csv.js";

const SEASONS = [2021, 2022, 2023, 2024, 2025];
const OUT = join(RAW_DIR, "..", "curated", "coverage.csv");

interface Against {
  targets: number;
  completions: number;
  yards: number;
  touchdowns: number;
  interceptions: number;
  brokenUp: number;
}

async function main(): Promise<void> {
  const rows: string[] = [
    "season,player,spot,targets,completions,yards,touchdowns,interceptions,brokenUp",
  ];

  for (const season of SEASONS) {
    const path = join(RAW_DIR, `play_by_play_${season}.csv`);

    if (!existsSync(path)) {
      continue;
    }

    // Only credit a corner. A safety who brings down a thirty yard
    // completion is usually the last man rather than the one who was
    // covering, and charging him for it put Minkah Fitzpatrick among
    // the worst in the league. The depth chart separates the two where
    // the roster's own label says DB for both.
    const corners = new Set<string>();
    const safeties = new Set<string>();

    for (const row of await loadWeeklyRosters(season)) {
      if (row.rawPosition !== "DB") continue;
      if (row.depthPosition === "CB") corners.add(row.playerId);
      else if (row.depthPosition) safeties.add(row.playerId);
    }

    const against = new Map<string, Against>();
    const reader = createInterface({ input: createReadStream(path) });
    let header: string[] | undefined;
    const at: Record<string, number> = {};

    for await (const line of reader) {
      if (!header) {
        header = splitLine(line);
        for (const field of [
          "play_type", "complete_pass", "receiving_yards", "yards_gained",
          "touchdown", "pass_defense_1_player_id", "interception_player_id",
          "solo_tackle_1_player_id", "assist_tackle_1_player_id",
        ]) {
          at[field] = header.indexOf(field);
        }
        continue;
      }

      const c = splitLine(line);

      if (c[at["play_type"]!] !== "pass") {
        continue;
      }

      const complete = c[at["complete_pass"]!] === "1";
      const brokeItUp = c[at["pass_defense_1_player_id"]!] ?? "";
      const picked = c[at["interception_player_id"]!] ?? "";
      const tackler = c[at["solo_tackle_1_player_id"]!] ?? "";

      // whoever the play names, in the order that most likely covered
      // a break-up or a pick names the coverage man whoever he is; a
      // tackle only counts it against a corner
      const covering = [picked, brokeItUp]
        .find((id) => id && id !== "NA" && (corners.has(id) || safeties.has(id)))
        ?? (complete && tackler && tackler !== "NA" && corners.has(tackler)
          ? tackler : undefined);

      if (!covering) {
        continue;
      }

      const own = against.get(covering) ??
        { targets: 0, completions: 0, yards: 0, touchdowns: 0, interceptions: 0, brokenUp: 0 };
      own.targets++;
      if (complete) {
        own.completions++;
        own.yards += Number(c[at["receiving_yards"]!]) || Number(c[at["yards_gained"]!]) || 0;
        if (c[at["touchdown"]!] === "1") own.touchdowns++;
      }
      if (picked === covering) own.interceptions++;
      if (brokeItUp === covering) own.brokenUp++;
      against.set(covering, own);
    }

    for (const [player, own] of against) {
      if (own.targets < 8) continue;
      rows.push([
        season, player, corners.has(player) ? "CB" : "S",
        own.targets, own.completions, own.yards.toFixed(0),
        own.touchdowns, own.interceptions, own.brokenUp,
      ].join(","));
    }

    console.log(`${season}: ${against.size} defenders`);
  }

  await writeFile(OUT, rows.join("\n") + "\n");
  console.log(`wrote ${rows.length - 1} rows`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
