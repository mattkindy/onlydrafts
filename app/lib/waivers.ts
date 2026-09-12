/**
 * What the wire is worth to you, in weeks won rather than points.
 *
 * A pickup is priced the way the draft board prices a pick: the week is
 * drawn for your roster, the best legal lineup is filled, and a man is
 * worth the change in how often that lineup beats a typical side. So a
 * third quarterback reads nothing however good he is, and a fourth back
 * reads something. Dropping is the same question backwards.
 *
 * Putting the two together is not a subtraction. With a roster spot
 * open nobody has to go, and when there is none, the man the newcomer
 * pushes to the bench is the cheapest to let go, and he costs less once
 * the newcomer is there.
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

export interface Net {
  /** what the whole move is worth, the drop paid for */
  net: number;
  /** who goes, or nobody when there is a spot for him */
  drop: Player | null;
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

/**
 * How many men you can carry, bench included.
 *
 * A list of slots is all any provider says about the size of a roster.
 * Sleeper lists every spot, so injured reserve and taxi come off: a man
 * parked there is not somebody you had to make room for. Nothing is
 * known about the size when there are no slots.
 */
export function capacityOf(slots: string[] | null | undefined): number | null {
  if (!slots) {
    return null;
  }

  return slots.filter((slot) => slot !== "IR" && slot !== "TAXI").length;
}

/** how many men you could add before somebody has to go */
export function openSpotsFor(
  slots: string[] | null | undefined, rostered: number,
): number | null {
  const capacity = capacityOf(slots);

  if (capacity === null) {
    return null;
  }

  return Math.max(0, capacity - rostered);
}

/**
 * What adding one man is worth once you have paid for him.
 *
 * With a spot open he costs nobody, so the move is worth what he adds.
 * Otherwise he goes on the roster, every man on it is priced for
 * dropping with him already there, and the cheapest of them goes. What
 * you gain is the week you win with him and without that man, against
 * the week you win now.
 */
export function netFor(
  mine: Player[], add: Add, slots: string[] | null | undefined, room: Room,
  openSpots: number | null,
): Net {
  if (openSpots !== null && openSpots > 0) {
    return { net: add.added, drop: null };
  }

  const now = baselineFor(mine, slots, room.draws, room.wire);
  const held = winChance(now.total, room.opponent);
  const withHim = [...mine, add.p];
  const cheapest = dropsFor(withHim, slots, room)
    .filter((d) => d.p.key !== add.p.key)
    .pop();

  if (!cheapest) {
    return { net: add.added, drop: null };
  }

  const after = baselineFor(
    withHim.filter((p) => p.key !== cheapest.p.key),
    slots, room.draws, room.wire,
  );

  return {
    net: winChance(after.total, room.opponent) - held,
    drop: cheapest.p,
  };
}
