/**
 * Who you keep, what it costs, and who the other teams take with you.
 *
 * No keeper prices ship with the board, since they belong to one
 * league and this serves any. What you type stays in this browser.
 */

import { stored, keep } from "./store.ts";
import type { Player } from "./scoring.ts";
import type { League } from "./providers.ts";
import {
  CLOSE_SEASON, bestLeftAt, marginAt, stillThereAt, worthUpTo,
  type Draft,
} from "./picks.ts";

const forLeague = (what: string, leagueId: string) => what + "." + leagueId;

export const keeperCosts = (leagueId: string) =>
  stored<Record<string, number>>(forLeague("keeperCost", leagueId), {});

export function saveKeeperCost(leagueId: string, key: string, round: number) {
  const all = keeperCosts(leagueId);

  if (round) {
    all[key] = round;
  } else {
    delete all[key];
  }

  keep(forLeague("keeperCost", leagueId), all);
}

export const markedKeepers = (leagueId: string) =>
  stored<Record<string, string>>(forLeague("keepers.v2", leagueId), {});

export const saveMarkedKeepers = (leagueId: string, map: Record<string, string>) =>
  keep(forLeague("keepers.v2", leagueId), map);

/**
 * Where the room takes a man kept a second year running, which you can
 * correct. His price is wherever he goes, so it is worth typing in for
 * those few rather than chasing the whole board.
 */
export const adpOverrides = (leagueId: string) =>
  stored<Record<string, number>>(forLeague("adpAt", leagueId), {});

export function saveAdpAt(leagueId: string, key: string, pick: number) {
  const all = adpOverrides(leagueId);

  if (pick) {
    all[key] = pick;
  } else {
    delete all[key];
  }

  keep(forLeague("adpAt", leagueId), all);
}

/** the men every other team is likely to keep, so a pick cannot buy them */
export function likelyKept(
  league: League,
  byKey: Map<string, Player>,
  perTeam: number,
): Set<string> {
  const gone = new Set<string>();

  for (const roster of league.allRosters) {
    if (roster.owner === league.team) {
      continue;
    }

    // it cannot keep more men than it has picks left to pay with
    const canAfford = Math.min(perTeam, roster.picks.length);

    roster.keys
      .map((r) => byKey.get(r.key))
      .filter((p): p is Player => Boolean(p))
      .sort((a, b) => (b.vor ?? 0) - (a.vor ?? 0))
      .slice(0, canAfford)
      .forEach((p) => gone.add(p.key));
  }

  return gone;
}

export interface Beaten {
  who: Player;
  odds: number;
  better: number;
  gain: number;
}

/** men at his position who are better and likely still there anyway */
export function betterLater(
  men: Player[],
  p: Player,
  costPick: number,
  taken: Set<string>,
): Beaten[] {
  return men
    .filter((o) =>
      o.key !== p.key && !taken.has(o.key) && o.adp &&
      o.position === p.position &&
      (o.vor ?? 0) - (p.vor ?? 0) > CLOSE_SEASON &&
      stillThereAt(o, costPick) >= 0.25)
    .map((o) => ({
      who: o,
      odds: stillThereAt(o, costPick),
      better: (o.vor ?? 0) - (p.vor ?? 0),
      gain: stillThereAt(o, costPick) * ((o.vor ?? 0) - (p.vor ?? 0)),
    }))
    .sort((a, b) => b.gain - a.gain)
    .slice(0, 3);
}

/**
 * Which of them you actually keep.
 *
 * Each man is judged against the best player at his position still on
 * the board at the pick he costs, so what you do with one does not
 * change what another is worth. That leaves ranking them by how far
 * they beat their price: two men who cost the same round cannot both
 * be kept, and neither can anyone whose round you traded away.
 */
export function whoToKeep(
  men: Player[],
  onRoster: Player[],
  costs: Record<string, number>,
  draft: Draft,
  slots: number,
  myRounds: number[] | null,
): string[] {
  const spent = new Set<number>();
  const keeping: string[] = [];

  const ranked = onRoster
    .map((p) => {
      const cost = Number(costs[p.key]) || 0;

      return { p, cost, at: cost ? marginAt(men, p, cost, draft) : null };
    })
    .filter((m) => m.at && m.at.margin > 0)
    .filter((m) => !myRounds || myRounds.includes(m.cost))
    .sort((a, b) => b.at!.margin - a.at!.margin);

  for (const { p, cost } of ranked) {
    if (keeping.length >= slots) {
      break;
    }

    if (spent.has(cost)) {
      continue;
    }

    spent.add(cost);
    keeping.push(p.key);
  }

  return keeping;
}

/** the earliest round each of your men still beats */
export const worthUpToEach = (men: Player[], onRoster: Player[], draft: Draft) =>
  onRoster
    .map((p) => ({ p, ...worthUpTo(men, p, draft) }))
    .sort((a, b) => a.round - b.round);

export { bestLeftAt };
