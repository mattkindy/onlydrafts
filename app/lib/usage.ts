/**
 * What a player's work has looked like, recently and over the season.
 *
 * Points say what happened. Snaps, carries, targets and looks inside the
 * 20 say what is likely to keep happening, since a role settles in a few
 * games and touchdowns arrive in lumps. A player scoring on 30% of the
 * snaps is a different pickup from one scoring on 80%, and the change
 * between his last few games and the rest is where a new role shows.
 */

import type { Player } from "./scoring.ts";

/** his work in an average game of some stretch */
export interface Work {
  games: number;
  /** percent of his side's offensive snaps */
  snaps: number;
  carries: number;
  targets: number;
  /** carries and targets inside the 20 */
  redZone: number;
}

/** how many of his latest games count as recent */
export const RECENT = 3;

/**
 * A move in snap share this big between his recent games and the ones
 * before is a role changing, the same gap the in-season update breaks a
 * player's window at.
 */
export const ROLE_MOVE = 20;

function workOver(uses: NonNullable<NonNullable<Player["weeks"]>[number]["use"]>[]): Work | null {
  if (uses.length === 0) {
    return null;
  }

  const mean = (i: number) =>
    uses.reduce((sum, use) => sum + use[i]!, 0) / uses.length;

  return {
    games: uses.length,
    snaps: mean(0),
    carries: mean(1),
    targets: mean(2),
    redZone: mean(3),
  };
}

/**
 * His work over his latest games, over the games before them, and over the
 * whole season. Nothing at all for a player with no game counted.
 */
export function workOf(
  p: Player, recent = RECENT,
): { recent: Work; before: Work | null; season: Work } | null {
  const uses = (p.weeks ?? [])
    .flatMap((w) => w.use ? [w.use] : []);
  const season = workOver(uses);

  if (!season) {
    return null;
  }

  return {
    recent: workOver(uses.slice(-recent))!,
    before: workOver(uses.slice(0, -recent)),
    season,
  };
}

/**
 * His work in a few words for a table row: "71% snaps, up from 42%" when
 * the role moved, otherwise "71% snaps", with the touches beside it.
 */
export function workWords(p: Player): string {
  const work = workOf(p);

  if (!work) {
    return "";
  }

  const { recent, before } = work;
  const snaps = `${Math.round(recent.snaps)}% snaps`;
  const moved = before && Math.abs(recent.snaps - before.snaps) >= ROLE_MOVE
    ? `, ${recent.snaps > before.snaps ? "up" : "down"} from ` +
      `${Math.round(before.snaps)}%`
    : "";
  const touches = recent.carries + recent.targets;
  const red = recent.redZone >= 0.5 ? `, ${recent.redZone.toFixed(1)} in the 20` : "";

  return `${snaps}${moved}, ${touches.toFixed(1)} touches${red}`;
}
