/**
 * The fitted game script table, as written by
 * scripts/aggregateGameScript.ts.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "./csv.js";
import { scriptFrom, type Effect, type Script } from "../features/gameScript.js";

const CURATED = join(import.meta.dirname, "..", "..", "data", "curated");

/** a season nobody has walked leaves every fixture level */
export async function loadGameScript(season: number): Promise<Script> {
  try {
    const rows = parseCsv(await readFile(join(CURATED, "gameScript.csv"), "utf8"));
    const effects: Effect[] = rows
      .filter((r) => Number(r["season"]) === season)
      .map((r) => ({
        defence: r["defence"] ?? "",
        carries: Number(r["carries"]) || 1,
        targets: Number(r["targets"]) || 1,
      }));

    return scriptFrom(effects);
  } catch {
    return scriptFrom([]);
  }
}
