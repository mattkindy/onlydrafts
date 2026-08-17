/**
 * Where each man was listed before the season started.
 *
 * The share model works this out by ranking a team's players on what
 * they did last year. The league publishes it, and publishes it in
 * August, so it is known on draft day and knows nothing that has not
 * happened yet.
 *
 * The release changed shape in 2025. Before that there is a row per
 * week with the standing in `depth_team`; since then there are dated
 * snapshots with it in `pos_rank`. Both come back the same way here.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "./csv.js";
import { RAW_DIR } from "./nflverse.js";

export interface DepthSpot {
  playerId: string;
  team: string;
  position: string;
  /** one for the starter, two for the man behind him */
  rank: number;
}

/**
 * The last chart published before the season began, so nothing in it
 * depends on how the season went.
 */
export async function loadDepthChart(season: number): Promise<Map<string, DepthSpot>> {
  const rows = parseCsv(
    await readFile(join(RAW_DIR, `depth_charts_${season}.csv`), "utf8"),
  );
  const spots = new Map<string, DepthSpot>();

  if (rows.length && rows[0]!["pos_rank"] !== undefined) {
    const dated = rows.filter((r) =>
      (r["gsis_id"] ?? "").startsWith("00-") &&
      (r["dt"] ?? "") < `${season}-09-05`);
    const days = [...new Set(dated.map((r) => (r["dt"] ?? "").slice(0, 10)))].sort();
    const last = days[days.length - 1] ?? "";

    for (const row of dated.filter((r) => (r["dt"] ?? "").startsWith(last))) {
      const rank = Number(row["pos_rank"]);

      if (!Number.isFinite(rank)) {
        continue;
      }

      spots.set(row["gsis_id"]!, {
        playerId: row["gsis_id"]!, team: row["team"] ?? "",
        position: row["pos_abb"] ?? "", rank,
      });
    }

    return spots;
  }

  // the older shape: week one of the regular season is the first chart
  // that stands for how a team means to line up
  for (const row of rows) {
    if (Number(row["week"]) !== 1 || row["game_type"] !== "REG") {
      continue;
    }

    const playerId = row["gsis_id"] ?? "";
    const rank = Number(row["depth_team"]);

    if (!playerId.startsWith("00-") || !Number.isFinite(rank)) {
      continue;
    }

    // a man can be listed at more than one spot; keep the highest
    const already = spots.get(playerId);

    if (already && already.rank <= rank) {
      continue;
    }

    spots.set(playerId, {
      playerId, team: row["club_code"] ?? "",
      position: row["depth_position"] || (row["position"] ?? ""), rank,
    });
  }

  return spots;
}
