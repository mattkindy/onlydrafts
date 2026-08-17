/**
 * The kick and the clock, read off the plays rather than written down.
 *
 * The walk carried a step function for how often a kick goes over, and
 * it was too kind from forty to fifty: 87% where kickers really make
 * 79.8%, which is why too few are missed. The clock was a chance taken
 * off every drive, where a half runs out on one of them.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../data/csv.js";
import { RAW_DIR } from "../data/nflverse.js";

export interface Endings {
  /** how often a kick from this yard line goes over */
  kickSucceeds: (yardline: number) => number;
  /** how often a drive is the last of a half */
  isLast: number;
  /** how many snaps one of those gets, drawn */
  lastLength: (uniform: () => number) => number;
}

/** a kick is from the yard line plus the snap and the end zone */
const lengthOf = (yardline: number) => yardline + 17;

export async function fitEndings(seasons: number[]): Promise<Endings> {
  const rows = parseCsv(
    await readFile(join(RAW_DIR, "..", "curated", "endings.csv"), "utf8"),
  ).filter((r) => seasons.includes(Number(r["season"])));

  const kicks = rows.filter((r) => r["kind"] === "kick")
    .map((r) => ({ length: Number(r["length"]), made: Number(r["made"]) }))
    .filter((k) => Number.isFinite(k.length) && k.length > 10 && k.length < 75);

  // one number per yard of distance, widened until enough kicks are in it
  const made = new Map<number, number>();

  for (let length = 15; length <= 70; length++) {
    let hit = 0;
    let all = 0;

    for (const reach of [1, 2, 3, 5, 8, 12]) {
      hit = 0;
      all = 0;

      for (const kick of kicks) {
        if (Math.abs(kick.length - length) <= reach) {
          all++;
          hit += kick.made;
        }
      }

      if (all >= 120) {
        break;
      }
    }

    made.set(length, all === 0 ? 0.7 : hit / all);
  }

  const drives = parseCsv(
    await readFile(join(RAW_DIR, "..", "curated", "drives.csv"), "utf8"),
  ).filter((r) => seasons.includes(Number(r["season"])));
  const ranOut = drives.filter((r) => r["result"] === "End of half");
  const lengths = ranOut.map((r) => Number(r["plays"]) || 1);

  return {
    kickSucceeds: (yardline) => {
      const length = Math.round(lengthOf(yardline));
      return made.get(Math.max(15, Math.min(70, length))) ?? 0.7;
    },
    isLast: ranOut.length / Math.max(1, drives.length),
    lastLength: (uniform) =>
      lengths.length === 0
        ? 4
        : lengths[Math.floor(uniform() * lengths.length)]!,
  };
}
