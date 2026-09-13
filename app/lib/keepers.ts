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
  CLOSE_SEASON, stillThereAt, worthUpTo, type Draft,
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

/** the players every other team is likely to keep, so a pick cannot buy them */
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

    // it cannot keep more players than it has picks left to pay with
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

/** players at his position who are better and likely still there anyway */
export function betterLater(
  players: Player[],
  p: Player,
  costPick: number,
  taken: Set<string>,
): Beaten[] {
  return players
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

/** the earliest round each of your players still beats */
export const worthUpToEach = (players: Player[], onRoster: Player[], draft: Draft) =>
  onRoster
    .map((p) => ({ p, ...worthUpTo(players, p, draft) }))
    .sort((a, b) => a.round - b.round);
