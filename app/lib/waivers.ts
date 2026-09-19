/**
 * What the wire is worth to you, in weeks won rather than points.
 *
 * A pickup is priced the way the draft board prices a pick: the week is
 * drawn for your roster, the best legal lineup is filled, and a player is
 * worth the change in how often that lineup beats a typical side. So a
 * third quarterback reads nothing however good he is, and a fourth back
 * reads something. Dropping is the same question backwards.
 *
 * Putting the two together is not a subtraction. With a roster spot
 * open nobody has to go, and when there is none, the player the newcomer
 * pushes to the bench is the cheapest to let go, and he costs less once
 * the newcomer is there.
 */

import type { Player } from "./scoring.ts";
import type { Room } from "./draftShare.ts";
import {
  baselineFor, seasonLineupFor, slotOf, winChance, winShareFor, withoutFor,
  type Priced, type SeasonLineup,
} from "./winShare.ts";

/**
 * Under a point of win chance is inside the noise of a few thousand drawn
 * weeks, so a page that lists such a player is inviting a move that
 * changes nothing.
 */
export const WORTH_ADDING = 0.01;

/**
 * A player who is in the lineup less often than this is a bench player, and
 * naming the slot he takes in the odd week he starts tells a reader less
 * than saying he hardly ever starts.
 */
export const RARELY_STARTS = 1 / 3;

export interface Add extends Omit<Priced, "displaces"> {
  p: Player;
  /** the player he takes the slot from, or nobody when it was a wire slot */
  displaced: Player | null;
}

export interface Drop {
  p: Player;
  /** how much less often you win a week once he is gone */
  costs: number;
  starts: number;
  /** how many points a week your lineup loses with him gone */
  takes: number;
  /** how often you win a week with him, and how often without him */
  before: number;
  after: number;
  /** who starts most in the weeks he would have, nobody if the wire does */
  heir: Player | null;
  /** the slot he is in most of the weeks he starts, nobody's if he never does */
  slot: string | null;
}

export interface Net {
  /** what the whole move is worth, the drop paid for */
  net: number;
  /** who goes, or nobody when there is a spot for him */
  drop: Player | null;
  /** how often you win a week as you are, and how often after the move */
  before: number;
  after: number;
}

/**
 * Every player on the wire, by what adding him does to your week. One
 * baseline serves the whole pool, since none of these players is on your
 * roster and so none of them is being measured against himself.
 */
export function addsFor(
  mine: Player[], pool: Player[], slots: string[] | null | undefined,
  room: Room,
): Add[] {
  const base = baselineFor(mine, slots, room.draws, room.wire);
  const worth = winShareFor(base, room.opponent, room.draws);
  const byKey = new Map(mine.map((p) => [p.key, p]));

  return pool
    .map((p) => {
      const { displaces, ...his } = worth(p);

      return {
        p, ...his,
        displaced: displaces ? byKey.get(displaces) ?? null : null,
      };
    })
    .sort((a, b) => b.added - a.added);
}

/**
 * Every player on your roster, by what dropping him costs. Both sides are drawn
 * against the same opponent weeks, so the difference is him and not the
 * luck of two draws.
 */
export function dropsFor(
  mine: Player[], slots: string[] | null | undefined, room: Room,
): Drop[] {
  return dropsIn(seasonLineupFor(mine, slots, room.draws, room.wire), mine, room);
}

/**
 * The same, off a lineup somebody has already filled. Every player is
 * priced by the shuffle his leaving causes rather than by drawing the
 * season again without him, which is fifteen baselines saved.
 */
function dropsIn(held: SeasonLineup, mine: Player[], room: Room): Drop[] {
  const with_ = winChance(held.total, room.opponent);
  const weeks = Math.max(1, held.total.length);
  const scores = mean(held.total);

  return mine
    .map((p) => {
      const { total, gained } = withoutFor(held, p.key);
      const after = winChance(total, room.opponent);

      return {
        p,
        costs: with_ - after,
        starts: (held.started[p.key] ?? 0) / weeks,
        takes: scores - mean(total),
        before: with_,
        after,
        heir: heirTo(mine, p, gained),
        slot: slotOf(held, p.key),
      };
    })
    .sort((a, b) => b.costs - a.costs);
}

const mean = (xs: number[]) =>
  xs.reduce((sum, x) => sum + x, 0) / Math.max(1, xs.length);

/**
 * Who ends up starting in his place: the player who gains the most weeks in
 * the lineup once he is gone. Nobody, when every week he started is
 * filled off the wire instead.
 */
function heirTo(
  mine: Player[], gone: Player, gained: Record<string, number>,
): Player | null {
  let heir: Player | null = null;
  let most = 0;

  for (const q of mine) {
    if (q.key === gone.key) {
      continue;
    }

    if ((gained[q.key] ?? 0) > most) {
      most = gained[q.key]!;
      heir = q;
    }
  }

  return heir;
}

/**
 * How many players you can carry, bench included.
 *
 * A list of slots is all any provider says about the size of a roster.
 * Sleeper lists every spot, so injured reserve and taxi come off: a player
 * parked there is not somebody you had to make room for. Nothing is
 * known about the size when there are no slots.
 */
export function capacityOf(slots: string[] | null | undefined): number | null {
  if (!slots) {
    return null;
  }

  return slots.filter((slot) => slot !== "IR" && slot !== "TAXI").length;
}

/** how many players you could add before somebody has to go */
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
 * What adding one player is worth once you have paid for him.
 *
 * With a spot open he costs nobody, so the move is worth what he adds.
 * Otherwise he goes on the roster, every player on it is priced for
 * dropping with him already there, and the cheapest of them goes. What
 * you gain is the week you win with him and without that player, against
 * the week you win now.
 */
export function netFor(
  mine: Player[], add: Add, slots: string[] | null | undefined, room: Room,
  openSpots: number | null,
): Net {
  return netsFor(mine, [add], slots, room, openSpots).get(add.p.key)!;
}

/**
 * The same for a run of adds, with your own season filled once for the
 * lot of them rather than once each.
 */
export function netsFor(
  mine: Player[], adds: Add[], slots: string[] | null | undefined, room: Room,
  openSpots: number | null,
): Map<string, Net> {
  const nets = new Map<string, Net>();
  const alone = (add: Add): Net => ({
    net: add.added, drop: null, before: add.before, after: add.after,
  });

  if (openSpots !== null && openSpots > 0) {
    for (const add of adds) {
      nets.set(add.p.key, alone(add));
    }

    return nets;
  }

  const held = winChance(
    seasonLineupFor(mine, slots, room.draws, room.wire).total, room.opponent);

  for (const add of adds) {
    const withHim = [...mine, add.p];
    const cheapest = dropsIn(
      seasonLineupFor(withHim, slots, room.draws, room.wire), withHim, room)
      .filter((d) => d.p.key !== add.p.key)
      .pop();

    // the cheapest player's own after is the season with him gone and the
    // newcomer there, which is the swap, so nothing is filled again
    nets.set(add.p.key, cheapest
      ? {
        net: cheapest.after - held,
        drop: cheapest.p,
        before: held,
        after: cheapest.after,
      }
      : alone(add));
  }

  return nets;
}
