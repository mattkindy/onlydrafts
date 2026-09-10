/**
 * What changed on a club's offensive staff going into a season, for
 * every club, from the curated week-one staff list.
 *
 * The season model and the weekly model both ask this. A new
 * coordinator is the one thing that makes last season's numbers a poor
 * guide to this one, and the pass rate he ran at his last stop says
 * which way the change goes.
 */

import { loadCoaches } from "../data/coaches.js";
import { loadTendencies } from "../data/tendencies.js";

export interface StaffChange {
  /** a different offensive coordinator from last season */
  ocChanged: boolean;
  /** a different head coach from last season */
  hcChanged: boolean;
  /**
   * The new coordinator's neutral pass rate at his last stop, minus
   * this club's last season. 0 with no change or nothing to compare.
   */
  passShift: number;
}

export const NO_CHANGE: StaffChange = {
  ocChanged: false, hcChanged: false, passShift: 0,
};

export type CoachOf = (team: string, season: number, role: string) => string | undefined;

export async function staffChangesFor(
  target: number,
): Promise<{ changes: Map<string, StaffChange>; coachOf: CoachOf }> {
  const coaches = await loadCoaches();
  const tendencies = await loadTendencies();
  const coachOf: CoachOf = (team, season, role) =>
    coaches.get(`${team}|${season}|${role}`);
  const ocStops = new Map<string, { team: string; season: number }[]>();
  const teams = new Set<string>();

  for (const [key, name] of coaches) {
    const [team, seasonText, role] = key.split("|");

    if (Number(seasonText) === target || Number(seasonText) === target - 1) {
      teams.add(team!);
    }

    if (role !== "OC" || !name) {
      continue;
    }

    const list = ocStops.get(name) ?? [];
    list.push({ team: team!, season: Number(seasonText) });
    ocStops.set(name, list);
  }

  const changes = new Map<string, StaffChange>();

  for (const teamId of teams) {
    const oc = coachOf(teamId, target, "OC");
    const prevOc = coachOf(teamId, target - 1, "OC");
    const hc = coachOf(teamId, target, "HC");
    const prevHc = coachOf(teamId, target - 1, "HC");
    // an unknown staff is not a changed staff; without both seasons
    // there is no evidence of a change
    const ocChanged = oc !== undefined && prevOc !== undefined && oc !== prevOc;
    const hcChanged = hc !== undefined && prevHc !== undefined && hc !== prevHc;
    const teamPrev = tendencies.get(`${teamId}|${target - 1}`)?.neutralPassRate;

    if (oc === undefined || oc === prevOc || teamPrev === undefined) {
      changes.set(teamId, { ocChanged, hcChanged, passShift: 0 });
      continue;
    }

    const stop = (ocStops.get(oc) ?? [])
      .filter((s) => s.season < target && s.team !== teamId)
      .sort((a, b) => b.season - a.season)[0];
    const ocPrev = stop
      ? tendencies.get(`${stop.team}|${stop.season}`)?.neutralPassRate
      : undefined;
    changes.set(teamId, {
      ocChanged,
      hcChanged,
      passShift: ocPrev === undefined ? 0 : ocPrev - teamPrev,
    });
  }

  return { changes, coachOf };
}
