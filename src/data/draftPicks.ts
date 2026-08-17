/**
 * Where a player was drafted, which is the only thing said about a man
 * before he has played.
 *
 * A rookie has no share of anything to carry forward, so a model built
 * on last season puts every one of them at the back of the depth chart.
 * A first round receiver does not start at the back.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "./csv.js";
import { RAW_DIR } from "./nflverse.js";

export interface DraftPick {
  playerId: string;
  season: number;
  round: number;
  /** overall, so the top of a round counts for more than the bottom */
  pick: number;
  position: string;
  team: string;
}

export async function loadDraftPicks(): Promise<Map<string, DraftPick>> {
  const rows = parseCsv(
    await readFile(join(RAW_DIR, "draft_picks.csv"), "utf8"),
  );
  const byPlayer = new Map<string, DraftPick>();

  for (const row of rows) {
    const playerId = row["gsis_id"] ?? "";
    const pick = Number(row["pick"]);

    if (!playerId.startsWith("00-") || !Number.isFinite(pick)) {
      continue;
    }

    byPlayer.set(playerId, {
      playerId, season: Number(row["season"]), round: Number(row["round"]),
      pick, position: row["position"] ?? "", team: row["team"] ?? "",
    });
  }

  return byPlayer;
}

/**
 * A pick turned into something that can be sorted against a share.
 *
 * An undrafted man is worth less than the last pick, and a player who
 * was drafted years ago and still has no season behind him is not the
 * prospect his pick once made him, so it fades.
 */
export function standingFrom(
  pick: DraftPick | undefined, season: number,
): number {
  if (!pick) {
    return 0;
  }

  const yearsSince = Math.max(0, season - pick.season);
  const fresh = Math.max(0, 1 - Math.min(1, (pick.pick - 1) / 260));

  return fresh / (1 + yearsSince);
}
