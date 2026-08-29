/**
 * What a draft price says about a man's coming share of the work.
 *
 * The counts cannot tell a star back from a lost season apart from
 * the men who covered for him, and every August draft room can: he
 * goes eighth overall and they go undrafted. This turns that price
 * into the share men at that price have gone on to take, fitted on
 * earlier seasons, so a projection can lean toward the market's level
 * rather than only reordering its own.
 */

import { loadAdp } from "../data/adp.js";
import { loadPlayerStats, loadWeeklyRosters } from "../data/nflverse.js";
import { normalizeName } from "../data/names.js";

/** draft position cut where the role really changes */
const BANDS = [12, 24, 48, 96, 160, 999];

const bandOf = (adp: number) => BANDS.findIndex((edge) => adp <= edge);

export interface AdpShare {
  /** the shares men at this price and position have taken, per half */
  impliedShare: (
    position: string, adp: number,
  ) => { carry: number; target: number } | undefined;
}

export async function fitAdpShare(
  seasons: number[],
  teamPlaysOf: (season: number, team: string) => number,
): Promise<AdpShare> {
  const pooled = new Map<string, { carry: number[]; target: number[] }>();

  for (const season of seasons) {
    const adp = await loadAdp(season, "ppr").catch(() => null);

    if (!adp) {
      continue;
    }

    const carries = new Map<string, number>();
    const targets = new Map<string, number>();
    const teamOf = new Map<string, string>();
    const nameOf = new Map<string, { name: string; position: string }>();

    for (const s of await loadPlayerStats(season)) {
      if (s.week > 18) {
        continue;
      }

      carries.set(s.playerId, (carries.get(s.playerId) ?? 0) + (s.carries ?? 0));
      targets.set(s.playerId, (targets.get(s.playerId) ?? 0) + (s.targets ?? 0));
      teamOf.set(s.playerId, s.teamId);
    }

    for (const row of await loadWeeklyRosters(season)) {
      if (row.week === 1) {
        nameOf.set(row.playerId, { name: row.name, position: row.rawPosition });
      }
    }

    for (const [playerId, who] of nameOf) {
      const entry = adp.get(`${normalizeName(who.name)}|${who.position}`);

      if (!entry) {
        continue;
      }

      const ran = teamPlaysOf(season, teamOf.get(playerId) ?? "");

      if (ran <= 0) {
        continue;
      }

      const key = `${who.position}|${bandOf(entry.adp)}`;
      const into = pooled.get(key) ?? { carry: [], target: [] };
      into.carry.push((carries.get(playerId) ?? 0) / ran);
      into.target.push((targets.get(playerId) ?? 0) / ran);
      pooled.set(key, into);
    }
  }

  const middle = (of: number[]) =>
    of.reduce((a, b) => a + b, 0) / Math.max(1, of.length);

  return {
    impliedShare: (position, adp) => {
      const found = pooled.get(`${position}|${bandOf(adp)}`);

      return found && found.carry.length >= 8
        ? { carry: middle(found.carry), target: middle(found.target) }
        : undefined;
    },
  };
}
