/**
 * Why scaling a draw by the man who made it lifts the level.
 *
 * Letting each player gain his own yards gave the model its first
 * skill at ranking team games, and put three points a game on the
 * board that nobody scored. Either the men who get the ball are being
 * compared against a league average that includes plays no player
 * made, or the clamp around the multiplier is not centred on one.
 *
 * Run: npx tsx scripts/gainLevelEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import type { Call } from "../src/model/playFactors.js";

const LEARN = [2021, 2022, 2023, 2024];

interface Tally {
  plays: number;
  yards: number;
}

const empty = (): Tally => ({ plays: 0, yards: 0 });

const per = (tally: Tally) => tally.yards / Math.max(1, tally.plays);

async function main(): Promise<void> {
  const rows = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
  )).filter((r) => LEARN.includes(Number(r["season"])));

  const everything = new Map<Call, Tally>();
  const named = new Map<Call, Tally>();
  const nameless = new Map<Call, Tally>();
  const byMan = new Map<string, Tally>();

  for (const row of rows) {
    const call = (row["playType"] ?? "") as Call;

    if (call !== "run" && call !== "pass") {
      continue;
    }

    const yards = Number(row["yards"]) || 0;
    const player = row["player"] ?? "";

    for (const [into, key] of [
      [everything, call],
      [player ? named : nameless, call],
    ] as [Map<Call, Tally>, Call][]) {
      const own = into.get(key) ?? empty();
      own.plays++;
      own.yards += yards;
      into.set(key, own);
    }

    if (player) {
      const own = byMan.get(`${player}|${call}`) ?? empty();
      own.plays++;
      own.yards += yards;
      byMan.set(`${player}|${call}`, own);
    }
  }

  console.log("yards a play, over 2021 to 2024\n");
  console.log("  call   everything   with a man named   with nobody named   plays with nobody");

  for (const call of ["run", "pass"] as Call[]) {
    const all = everything.get(call) ?? empty();
    const some = named.get(call) ?? empty();
    const none = nameless.get(call) ?? empty();
    console.log(
      "  " + call.padEnd(7) +
        per(all).toFixed(3).padStart(10) +
        per(some).toFixed(3).padStart(19) +
        per(none).toFixed(3).padStart(20) +
        `${(100 * none.plays / Math.max(1, all.plays)).toFixed(1)}%`.padStart(20),
    );
  }

  // and what the multiplier would come out at, over the men who
  // actually get the ball rather than over every man on a roster
  console.log("\nthe multiplier each man would get, weighted by his touches\n");
  console.log("  call   against everything   against men only   over 1.8   under 0.5");

  for (const call of ["run", "pass"] as Call[]) {
    const all = per(everything.get(call) ?? empty());
    const some = per(named.get(call) ?? empty());
    let touches = 0;
    let againstAll = 0;
    let againstSome = 0;
    let over = 0;
    let under = 0;

    for (const [key, man] of byMan) {
      if (!key.endsWith(`|${call}`) || man.plays < 40) {
        continue;
      }

      const his = per(man);
      touches += man.plays;
      againstAll += man.plays * (his / all);
      againstSome += man.plays * (his / some);
      if (his / some > 1.8) over += man.plays;
      if (his / some < 0.5) under += man.plays;
    }

    console.log(
      "  " + call.padEnd(7) +
        (againstAll / Math.max(1, touches)).toFixed(3).padStart(18) +
        (againstSome / Math.max(1, touches)).toFixed(3).padStart(19) +
        `${(100 * over / Math.max(1, touches)).toFixed(1)}%`.padStart(11) +
        `${(100 * under / Math.max(1, touches)).toFixed(1)}%`.padStart(12),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
