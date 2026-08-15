import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeName } from "./names.js";
import { RAW_DIR } from "./nflverse.js";

export interface AdpEntry {
  name: string;
  position: string;
  /** average draft position; lower gets drafted earlier */
  adp: number;
}

/**
 * Preseason PPR ADP from Fantasy Football Calculator mock drafts,
 * snapshotted in the final week before each season. Keyed by
 * normalized name plus position, since the source has no gsis ids.
 */
export async function loadAdp(season: number): Promise<Map<string, AdpEntry>> {
  const text = await readFile(
    join(RAW_DIR, `adp_ppr_${season}.json`),
    "utf8",
  );
  const parsed = JSON.parse(text) as {
    players: { name: string; position: string; adp: number }[];
  };

  const result = new Map<string, AdpEntry>();

  for (const player of parsed.players) {
    result.set(`${normalizeName(player.name)}|${player.position}`, {
      name: player.name,
      position: player.position,
      adp: player.adp,
    });
  }

  return result;
}
