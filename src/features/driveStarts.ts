/**
 * Where drives really begin.
 *
 * A normal about the seventy five yard line looks close enough on the
 * median and is wrong in the tail that matters. One drive in twenty
 * five starts inside the opponent's thirty five, after a turnover or a
 * short punt, and those are the ones that score. Drawing from a curve
 * and clamping it at the thirty five threw all of them away.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../data/csv.js";
import { RAW_DIR } from "../data/nflverse.js";

export async function loadDriveStarts(seasons: number[]): Promise<number[]> {
  const rows = parseCsv(
    await readFile(join(RAW_DIR, "..", "curated", "drives.csv"), "utf8"),
  );
  const starts: number[] = [];

  for (const row of rows) {
    if (!seasons.includes(Number(row["season"]))) {
      continue;
    }

    const yard = Number(row["startYard"]);

    if (Number.isFinite(yard) && yard >= 1 && yard <= 99) {
      starts.push(yard);
    }
  }

  return starts;
}

/** one of them, drawn */
export const startFrom = (starts: number[], uniform: () => number): number =>
  starts.length === 0 ? 75 : starts[Math.floor(uniform() * starts.length)]!;
