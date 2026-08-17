import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeName } from "./names.js";
import { RAW_DIR } from "./nflverse.js";

export interface AdpEntry {
  name: string;
  position: string;
  /** average draft position; lower gets drafted earlier */
  adp: number;
  /** earliest and latest he actually went across the sampled drafts */
  high: number;
  low: number;
}

/** which set of mock drafts to read */
export type AdpFormat = "ppr" | "standard";

/**
 * Preseason ADP from Fantasy Football Calculator mock drafts,
 * snapshotted in the final week before each season. Keyed by
 * normalized name plus position, since the source has no gsis ids.
 *
 * The format matters more than it looks. The same receiver goes fifteen
 * to thirty places earlier in a PPR room than a standard one, so a
 * standard league reading the PPR board thinks the room will take
 * receivers who are still there and backs who are long gone.
 */
export async function loadAdp(
  season: number,
  format: AdpFormat = "ppr",
): Promise<Map<string, AdpEntry>> {
  const text = await readFile(
    join(RAW_DIR, `adp_${format}_${season}.json`),
    "utf8",
  );
  const parsed = JSON.parse(text) as {
    players: {
      name: string;
      position: string;
      adp: number;
      high?: number;
      low?: number;
    }[];
  };

  const result = new Map<string, AdpEntry>();

  for (const player of parsed.players) {
    result.set(`${normalizeName(player.name)}|${player.position}`, {
      name: player.name,
      position: player.position,
      adp: player.adp,
      high: player.high ?? player.adp,
      low: player.low ?? player.adp,
    });
  }

  return result;
}
