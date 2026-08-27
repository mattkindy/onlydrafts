/**
 * The fitted game script table, as written by
 * scripts/aggregateGameScript.ts.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "./csv.js";
import { scriptFrom, type Effect, type Script } from "../features/gameScript.js";

const CURATED = join(import.meta.dirname, "..", "..", "data", "curated");

/**
 * A season nobody has walked leaves every fixture level, and says so.
 *
 * It used to fall back quietly, which meant a bench asking what game
 * script was worth in 2025 got a table with no 2025 in it, ran every
 * fixture at 1.0, and reported the nothing it had done as a result.
 * The board would have done the same if the file went missing.
 */
export async function loadGameScript(
  season: number, warn: (said: string) => void = console.warn,
): Promise<Script> {
  let rows;

  try {
    rows = parseCsv(await readFile(join(CURATED, "gameScript.csv"), "utf8"));
  } catch {
    warn("no game script table, so every fixture is level. " +
      "Run scripts/aggregateGameScript.ts");

    return scriptFrom([]);
  }

  const effects: Effect[] = rows
    .filter((r) => Number(r["season"]) === season)
    .map((r) => ({
      defence: r["defence"] ?? "",
      carries: Number(r["carries"]) || 1,
      targets: Number(r["targets"]) || 1,
    }));

  if (effects.length === 0) {
    warn(`the game script table has nothing for ${season}, so every ` +
      `fixture is level. Run scripts/aggregateGameScript.ts ${season}`);
  }

  return scriptFrom(effects);
}
