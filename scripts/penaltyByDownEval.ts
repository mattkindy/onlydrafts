/**
 * Are penalties spread evenly over the downs?
 *
 * The walk throws one flag rate at every play whatever the down. If
 * defensive holding and interference cluster on third down, where they
 * hand over an automatic first, then a flat rate would convert third
 * downs too rarely. The model converts 40% of them where sides really
 * convert 46%, which is the shape that would produce.
 *
 * Run: npx tsx scripts/penaltyByDownEval.ts
 */

import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { splitLine } from "../src/data/csv.js";
import { RAW_DIR } from "../src/data/nflverse.js";

const SEASONS = [2021, 2022, 2023, 2024, 2025];

interface Tally {
  plays: number;
  flagged: number;
  /** flags that handed the offence a first down by themselves */
  gaveAFirst: number;
  yards: number;
}

const empty = (): Tally => ({ plays: 0, flagged: 0, gaveAFirst: 0, yards: 0 });

async function main(): Promise<void> {
  const byDown = new Map<number, Tally>();
  const byKind = new Map<string, number>();
  const kindOnThird = new Map<string, number>();

  for (const season of SEASONS) {
    const path = join(RAW_DIR, `play_by_play_${season}.csv`);

    if (!existsSync(path)) {
      continue;
    }

    const reader = createInterface({ input: createReadStream(path) });
    let header: string[] | undefined;
    const at: Record<string, number> = {};

    for await (const line of reader) {
      if (!header) {
        header = splitLine(line);
        header.forEach((name, i) => { at[name] = i; });
        continue;
      }

      const c = splitLine(line);

      if (!["run", "pass"].includes(c[at["play_type"]!] ?? "")) {
        continue;
      }

      const down = Number(c[at["down"]!]);

      if (!Number.isFinite(down) || down < 1 || down > 4) {
        continue;
      }

      const own = byDown.get(down) ?? empty();
      own.plays++;

      if (c[at["penalty"]!] === "1") {
        own.flagged++;
        own.yards += Number(c[at["penalty_yards"]!]) || 0;
        const kind = c[at["penalty_type"]!] ?? "";
        byKind.set(kind, (byKind.get(kind) ?? 0) + 1);

        if (down === 3) {
          kindOnThird.set(kind, (kindOnThird.get(kind) ?? 0) + 1);
        }

        if (c[at["first_down_penalty"]!] === "1") {
          own.gaveAFirst++;
        }
      }

      byDown.set(down, own);
    }
  }

  console.log("penalties by down, over 2021 to 2025\n");
  console.log(
    "  down     plays   flagged   gave a first by itself   yards a flag",
  );

  for (const down of [1, 2, 3, 4]) {
    const own = byDown.get(down);

    if (!own || own.plays < 500) {
      continue;
    }

    console.log(
      `  ${down}   ` + String(own.plays).padStart(8) +
        `${(100 * own.flagged / own.plays).toFixed(2)}%`.padStart(10) +
        `${(100 * own.gaveAFirst / own.plays).toFixed(2)}%`.padStart(25) +
        (own.yards / Math.max(1, own.flagged)).toFixed(1).padStart(15),
    );
  }

  // and which flags they are, since the ones that hand over a first
  // are a different thing from a false start
  console.log("\nwhat gets called on third down, as a share of its flags\n");
  const onThird = [...kindOnThird.values()].reduce((a, b) => a + b, 0);
  const everywhere = [...byKind.values()].reduce((a, b) => a + b, 0);

  for (const [kind, n] of [...kindOnThird.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    const anywhere = (byKind.get(kind) ?? 0) / Math.max(1, everywhere);
    console.log(
      "  " + kind.padEnd(32) +
        `${(100 * n / onThird).toFixed(1)}%`.padStart(7) +
        `   against ${(100 * anywhere).toFixed(1)}% of all flags`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
