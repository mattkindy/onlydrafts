/**
 * What the walk scored each man in a week, kept on disk.
 *
 * Playing a week costs minutes, so the numbers are written once by
 * scripts/walkWeekCache.ts and read back by anything that wants them. A
 * week that was never played is absent from the file, and a caller has to
 * cope with that rather than assume the file covers a season.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../data/csv.js";
import { RAW_DIR } from "../data/nflverse.js";

export const WALK_WEEKLY_PATH = join(RAW_DIR, "..", "curated", "walkWeekly.csv");

export interface WalkWeekRow {
  season: number;
  week: number;
  playerId: string;
  position: string;
  points: number;
  touches: number;
  tds: number;
}

const HEADER = "season,week,playerId,position,points,touches,tds";

export function walkKey(
  season: number,
  week: number,
  playerId: string,
): string {
  return `${season}|${week}|${playerId}`;
}

export function walkRowsToCsv(rows: WalkWeekRow[]): string {
  const lines = rows.map(
    (r) =>
      `${r.season},${r.week},${r.playerId},${r.position},${r.points.toFixed(4)},` +
      `${r.touches.toFixed(4)},${r.tds.toFixed(4)}`,
  );

  return [HEADER, ...lines].join("\n") + "\n";
}

export function parseWalkRows(text: string): Map<string, WalkWeekRow> {
  const rows = parseCsv(text).map((row) => ({
    season: Number(row["season"]),
    week: Number(row["week"]),
    playerId: row["playerId"] ?? "",
    position: row["position"] ?? "",
    points: Number(row["points"]),
    touches: Number(row["touches"]),
    tds: Number(row["tds"]),
  }));

  return new Map(
    rows.map((r) => [walkKey(r.season, r.week, r.playerId), r]),
  );
}

let cached: Map<string, WalkWeekRow> | undefined;

/** empty when nobody has played the weeks yet */
export async function loadWalkWeekly(): Promise<Map<string, WalkWeekRow>> {
  if (cached) {
    return cached;
  }

  try {
    cached = parseWalkRows(await readFile(WALK_WEEKLY_PATH, "utf8"));
  } catch {
    cached = new Map();
  }

  return cached;
}
