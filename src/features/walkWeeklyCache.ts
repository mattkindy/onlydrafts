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

/**
 * Where a variant of the walk keeps its week. A bench comparing two
 * settings needs both on disk at once, so each one writes its own file
 * under a name of its own.
 */
export const walkWeeklyPathFor = (variant: string): string =>
  join(RAW_DIR, "..", "curated", `walkWeekly-${variant}.csv`);

export interface WalkWeekRow {
  season: number;
  week: number;
  playerId: string;
  position: string;
  points: number;
  touches: number;
  tds: number;
  /**
   * What he scored in each game the walk dealt him, space separated. A
   * band or a boom chance wants the games themselves, and a threshold
   * nobody has picked yet cannot be read back out of a summary.
   */
  dealt: number[];
}

const HEADER = "season,week,playerId,position,points,touches,tds,dealt";

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
      `${r.touches.toFixed(4)},${r.tds.toFixed(4)},` +
      r.dealt.map((d) => d.toFixed(2)).join(" "),
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
    dealt: (row["dealt"] ?? "").split(" ").filter(Boolean).map(Number),
  }));

  return new Map(
    rows.map((r) => [walkKey(r.season, r.week, r.playerId), r]),
  );
}

const cached = new Map<string, Map<string, WalkWeekRow>>();

/** empty when nobody has played the weeks yet */
export async function loadWalkWeekly(
  path = WALK_WEEKLY_PATH,
): Promise<Map<string, WalkWeekRow>> {
  const already = cached.get(path);

  if (already) {
    return already;
  }

  const rows = await readFile(path, "utf8")
    .then(parseWalkRows)
    .catch(() => new Map<string, WalkWeekRow>());
  cached.set(path, rows);

  return rows;
}
