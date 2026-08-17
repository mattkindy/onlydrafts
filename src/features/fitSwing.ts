/**
 * How far a man's yards swing about his own average, from his plays.
 *
 * The model gave everybody 0.35. Men really swing 1.26 in the middle
 * and from 1.03 to 1.63 between the tenth and the ninetieth, so the
 * number was not a little wrong for a particular player, it was wrong
 * by three and a half times for all of them. It had been tuned until
 * hundred yard games came out right, which they did for the wrong
 * reason: the spread in how often a man touched it was covering for a
 * play that never varied enough.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../data/csv.js";
import { RAW_DIR } from "../data/nflverse.js";

/** what a position swings by, for a man with too few touches of his own */
export const BY_POSITION: Record<string, number> = {
  RB: 1.36, WR: 1.31, TE: 1.10, QB: 1.20,
};

export const TRUST_SWING_AFTER = 40;

export async function fitSwings(
  season: number,
  positions: Map<string, string>,
): Promise<Map<string, number>> {
  const rows = parseCsv(
    await readFile(join(RAW_DIR, "..", "curated", "touches.csv"), "utf8"),
  ).filter((r) => Number(r["season"]) === season && r["player"]);
  const gains = new Map<string, number[]>();

  for (const row of rows) {
    const player = row["player"]!;
    gains.set(player, [...(gains.get(player) ?? []), Number(row["yards"]) || 0]);
  }

  const swings = new Map<string, number>();

  for (const [player, list] of gains) {
    const league = BY_POSITION[positions.get(player) ?? "WR"] ?? 1.3;

    if (list.length < 10) {
      swings.set(player, league);
      continue;
    }

    const mean = list.reduce((a, b) => a + b, 0) / list.length;

    if (mean <= 0.5) {
      swings.set(player, league);
      continue;
    }

    const spread = Math.sqrt(
      list.reduce((a, b) => a + (b - mean) ** 2, 0) / list.length,
    ) / mean;
    // his own, believed in proportion to how many touches he has had
    const his = (spread * list.length + league * TRUST_SWING_AFTER) /
      (list.length + TRUST_SWING_AFTER);
    swings.set(player, Math.max(0.5, Math.min(2.5, his)));
  }

  return swings;
}
