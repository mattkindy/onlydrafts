/**
 * How often a penalty keeps a drive alive.
 *
 * The drive walk stalls more often than real drives do: 37.8% end in
 * three plays or fewer against 25%. It only knows about runs and
 * passes, so a drive that carried on because the defence was flagged
 * has no way to happen in it.
 *
 * Run: npx tsx scripts/penaltyCheck.ts [season]
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { splitLine } from "../src/data/csv.js";
import { RAW_DIR } from "../src/data/nflverse.js";

const season = Number(process.argv[2] ?? 2024);

async function main(): Promise<void> {
  const reader = createInterface({
    input: createReadStream(join(RAW_DIR, `play_by_play_${season}.csv`)),
  });
  let header: string[] | undefined;
  const at: Record<string, number> = {};
  const drives = new Set<string>();
  let penaltyFirsts = 0;
  let byDefence = 0;
  const yards: number[] = [];
  const onDown = new Map<string, number>();

  for await (const line of reader) {
    if (!header) {
      header = splitLine(line);
      for (const field of [
        "first_down_penalty", "penalty", "drive", "game_id",
        "penalty_team", "posteam", "penalty_yards", "down", "ydstogo",
      ]) {
        at[field] = header.indexOf(field);
      }
      continue;
    }

    const c = splitLine(line);
    const drive = c[at["drive"]!];

    if (drive) {
      drives.add(`${c[at["game_id"]!]}|${drive}`);
    }

    if (c[at["first_down_penalty"]!] === "1") {
      penaltyFirsts++;

      if (c[at["penalty_team"]!] && c[at["penalty_team"]!] !== c[at["posteam"]!]) {
        byDefence++;
      }

      const gained = Number(c[at["penalty_yards"]!]);

      if (Number.isFinite(gained)) {
        yards.push(gained);
      }

      const down = c[at["down"]!];

      if (down) {
        onDown.set(down, (onDown.get(down) ?? 0) + 1);
      }
    }
  }

  console.log(`${season}: ${drives.size} drives`);
  console.log(
    `  first downs handed over by penalty: ${penaltyFirsts}, ` +
      `${(penaltyFirsts / drives.size).toFixed(3)} a drive`,
  );
  console.log(
    `  of those, on the defence: ${byDefence} ` +
      `(${(100 * byDefence / Math.max(1, penaltyFirsts)).toFixed(0)}%)`,
  );
  const middle = yards.reduce((a, b) => a + b, 0) / Math.max(1, yards.length);
  const sorted = [...yards].sort((a, b) => a - b);
  console.log(
    `  they are worth ${middle.toFixed(1)} yards on average, ` +
      `middle one ${sorted[Math.floor(sorted.length / 2)]}`,
  );
  console.log("  which down they came on:");

  for (const [down, count] of [...onDown].sort()) {
    console.log(
      `    ${down}: ${count} (${(100 * count / penaltyFirsts).toFixed(0)}%)`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
