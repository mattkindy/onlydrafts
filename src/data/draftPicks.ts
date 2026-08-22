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
import { loadWeeklyRosters } from "./nflverse.js";
import { normalizeName } from "./names.js";
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

/**
 * Everyone ever drafted, by the id the rest of the model uses.
 *
 * The newest class arrives before the league has issued its ids, so
 * those rows carry a placeholder like LOV121782 and were being thrown
 * away: all 257 picks of 2026, which left every rookie with no draft
 * capital, no projected share of the work and a place near the bottom
 * of the board. Those rows are matched by name against the rosters
 * instead.
 */
export async function loadDraftPicks(
  seasons: number[] = [2026, 2025],
): Promise<Map<string, DraftPick>> {
  const rows = parseCsv(
    await readFile(join(RAW_DIR, "draft_picks.csv"), "utf8"),
  );
  const idOf = new Map<string, string>();

  for (const season of seasons) {
    for (const man of await loadWeeklyRosters(season).catch(() => [])) {
      const key = `${normalizeName(man.name)}|${man.rawPosition}`;

      if (!idOf.has(key)) {
        idOf.set(key, man.playerId);
      }
    }
  }

  const byPlayer = new Map<string, DraftPick>();

  for (const row of rows) {
    const said = row["gsis_id"] ?? "";
    const pick = Number(row["pick"]);
    const position = row["position"] ?? "";
    const playerId = said.startsWith("00-")
      ? said
      : idOf.get(`${normalizeName(row["pfr_player_name"] ?? "")}|${position}`) ??
        "";

    if (!playerId || !Number.isFinite(pick)) {
      continue;
    }

    byPlayer.set(playerId, {
      playerId, season: Number(row["season"]), round: Number(row["round"]),
      pick, position, team: row["team"] ?? "",
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
