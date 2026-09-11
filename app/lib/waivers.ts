/**
 * What the wire is worth to you, in weeks won rather than points.
 *
 * A pickup is priced the way the draft board prices a pick: the week is
 * drawn for your roster, the best legal lineup is filled, and a man is
 * worth the change in how often that lineup beats a typical side in
 * your league. So a third quarterback reads nothing however good he is,
 * and a fourth back reads something, because byes and injuries mean he
 * starts some weeks.
 *
 * Dropping is the same question backwards. Take him off the roster,
 * fill the lineup again, and what you lose is what he was holding.
 */

import type { Player } from "./scoring.ts";
import type { Room } from "./draftShare.ts";
import { baselineFor, winChance, winShareFor } from "./winShare.ts";

export interface Add {
  p: Player;
  /** how much more often you win a week with him on the roster */
  added: number;
  /** how often he ends up in the lineup at all */
  starts: number;
}

export interface Drop {
  p: Player;
  /** how much less often you win a week once he is gone */
  costs: number;
  starts: number;
}

/**
 * Every man on the wire, by what adding him does to your week. One
 * baseline serves the whole pool, since none of these men is on your
 * roster and so none of them is being measured against himself.
 */
export function addsFor(
  mine: Player[], pool: Player[], slots: string[] | null | undefined,
  room: Room,
): Add[] {
  const base = baselineFor(mine, slots, room.draws, room.wire);
  const worth = winShareFor(base, room.opponent, room.draws);

  return pool
    .map((p) => ({ p, ...worth(p) }))
    .sort((a, b) => b.added - a.added);
}

/**
 * Every man on your roster, by what dropping him costs. Both sides are drawn
 * against the same opponent weeks, so the difference is him and not the
 * luck of two draws.
 */
export function dropsFor(
  mine: Player[], slots: string[] | null | undefined, room: Room,
): Drop[] {
  const held = baselineFor(mine, slots, room.draws, room.wire);
  const with_ = winChance(held.total, room.opponent);
  const weeks = Math.max(1, held.total.length);

  return mine
    .map((p) => {
      const rest = mine.filter((q) => q.key !== p.key);
      const base = baselineFor(rest, slots, room.draws, room.wire);

      return {
        p,
        costs: with_ - winChance(base.total, room.opponent),
        starts: (held.started[p.key] ?? 0) / weeks,
      };
    })
    .sort((a, b) => b.costs - a.costs);
}
