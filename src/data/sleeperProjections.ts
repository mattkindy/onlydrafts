/**
 * Sleeper's own weekly projections, keyed the way the rest of the repo
 * keys players.
 *
 * Sleeper publishes a projection per player-week under its own player
 * ids, so every row has to be joined to a gsis id before anything here
 * can use it. A player Sleeper has no gsis id for is dropped: he cannot
 * be matched to a weekly example, and guessing by name would quietly
 * pair up the wrong men.
 *
 * The points column is full PPR. The catches column lets a build in
 * another scoring take the point a catch back off.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "./csv.js";
import { RAW_DIR } from "./nflverse.js";

export const SLEEPER_WEEKLY_PATH = join(
  RAW_DIR,
  "..",
  "curated",
  "sleeperWeekly.csv",
);

export interface SleeperProjection {
  season: number;
  week: number;
  gsisId: string;
  position: string;
  points: number;
  targets: number;
  carries: number;
  /** undefined on a row fetched before catches were kept */
  catches?: number;
}

/** one row of the projections endpoint, cut down to what is used */
export interface SleeperProjectionRow {
  player_id: string;
  player?: { position?: string | null } | null;
  stats?: {
    pts_ppr?: number | null;
    rec?: number | null;
    rec_tgt?: number | null;
    rush_att?: number | null;
  } | null;
}

/**
 * His Sleeper points under a league's scoring. Sleeper's three formats
 * differ only in what a catch pays, so the full PPR number less the
 * difference per catch is exactly what Sleeper would publish for the
 * league. A row without catches stays as published.
 */
export function sleeperPointsUnder(
  projection: SleeperProjection, perCatch: number,
): number {
  if (projection.catches === undefined) {
    return projection.points;
  }

  return projection.points + (perCatch - 1) * projection.catches;
}

export function joinProjectionsToGsis(
  season: number,
  week: number,
  rows: SleeperProjectionRow[],
  gsisBySleeperId: Map<string, string>,
): SleeperProjection[] {
  const joined: SleeperProjection[] = [];

  for (const row of rows) {
    const gsisId = gsisBySleeperId.get(row.player_id);

    if (!gsisId) {
      continue;
    }

    const points = row.stats?.pts_ppr;

    if (points === undefined || points === null) {
      continue;
    }

    joined.push({
      season,
      week,
      gsisId,
      position: row.player?.position ?? "",
      points,
      targets: row.stats?.rec_tgt ?? 0,
      carries: row.stats?.rush_att ?? 0,
      catches: row.stats?.rec ?? 0,
    });
  }

  return joined;
}

export function projectionKey(
  season: number,
  week: number,
  gsisId: string,
): string {
  return `${season}|${week}|${gsisId}`;
}

let cached: Map<string, SleeperProjection> | undefined;

export async function loadSleeperWeekly(): Promise<
  Map<string, SleeperProjection>
> {
  if (cached) {
    return cached;
  }

  const rows = parseCsv(await readFile(SLEEPER_WEEKLY_PATH, "utf8"));
  cached = new Map(
    rows.map((row) => {
      const projection: SleeperProjection = {
        season: Number(row["season"]),
        week: Number(row["week"]),
        gsisId: row["gsisId"] ?? "",
        position: row["position"] ?? "",
        points: Number(row["points"]),
        targets: Number(row["targets"]),
        carries: Number(row["carries"]),
      };

      if (row["catches"] !== undefined && row["catches"] !== "") {
        projection.catches = Number(row["catches"]);
      }

      return [
        projectionKey(projection.season, projection.week, projection.gsisId),
        projection,
      ];
    }),
  );

  return cached;
}
