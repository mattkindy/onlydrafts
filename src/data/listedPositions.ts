/**
 * Where a team lists a player, for the seasons where his stat rows say
 * something else.
 *
 * The weekly stat file gives every row one position, and for a player
 * on the field for both sides it picks the side the league thinks of
 * him as. Travis Hunter's 2025 rows all say CB, so a model that keeps
 * only QB, RB, WR and TE never sees the receiver who caught 28 balls.
 * The weekly roster is the team's own listing, it covers everyone on
 * the roster rather than only the players who touched the ball, and the
 * board already reads it for draft slot, age and team. The stat rows
 * still win when they say a fantasy position, since they say where he
 * scored. The roster gets asked when they do not.
 */

import { loadWeeklyRosters } from "./nflverse.js";
import { mapPosition } from "../graph/build.js";

const FANTASY_POSITIONS = new Set(["QB", "RB", "WR", "TE"]);

/** whether a label is one of the four the board projects */
export function isFantasyPosition(position: string): boolean {
  return FANTASY_POSITIONS.has(position);
}

/**
 * The position each player was listed at most often that season,
 * collapsed into the graph's groups so a fullback reads as a back.
 */
export async function listedPositions(
  season: number,
): Promise<Map<string, string>> {
  const weeks = new Map<string, Map<string, number>>();

  for (const appearance of await loadWeeklyRosters(season).catch(() => [])) {
    const listed = mapPosition(appearance.rawPosition);

    if (!listed) {
      continue;
    }

    const his = weeks.get(appearance.playerId) ?? new Map<string, number>();
    his.set(listed, (his.get(listed) ?? 0) + 1);
    weeks.set(appearance.playerId, his);
  }

  const most = new Map<string, string>();

  for (const [playerId, his] of weeks) {
    const top = [...his].sort((a, b) => b[1] - a[1])[0];

    if (top) {
      most.set(playerId, top[0]);
    }
  }

  return most;
}

/**
 * The position to project a player at. Undefined where neither source
 * puts him at one the board covers.
 */
export function fantasySpot(
  filedAt: string,
  listedAt: string | undefined,
): string | undefined {
  if (isFantasyPosition(filedAt)) {
    return filedAt;
  }

  if (listedAt !== undefined && isFantasyPosition(listedAt)) {
    return listedAt;
  }

  return undefined;
}
