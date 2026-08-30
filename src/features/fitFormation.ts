/**
 * Where the quarterback stands, drawn before the call is made.
 *
 * A side in the gun runs 41.7% of the time on first and ten between
 * the twenties and one under centre runs 67.7%, so the formation
 * decides more about the call than most of what the walk conditions
 * on. It is also the most personal thing a side has: a shotgun habit
 * is its own from one season to the next at .61, where its points a
 * game carry at .34. So the walk draws it, the league's rate here
 * tilted by how much this side leans, and the call is then asked of
 * the plays that were run from there.
 */

import type { PlayState } from "../model/playFactors.js";

export interface FormationRow {
  season: number;
  offence: string;
  down: number;
  toGo: number;
  shotgun: number;
  noHuddle: number;
}

export interface Formation {
  /** how often this side is in the gun here, near the league's rate */
  gunHere: (state: PlayState, offence?: string) => number;
  /**
   * How much more of the gun this side takes than everybody, near
   * one. The caller multiplies it by the league's rate at its own
   * cells, so the two agree on where a side with no habit lands.
   */
  leaning: (offence?: string) => number;
  /** how many sides had enough plays to speak for themselves */
  learnedFrom: number;
}

/** a side needs this many plays before its own habit is believed at all */
const SETTLES_AT = 300;
const band = (down: number, toGo: number) =>
  `${Math.min(3, down)}|${toGo <= 2 ? "short" : toGo <= 6 ? "medium" : "long"}`;

export function fitFormation(
  rows: FormationRow[],
  /** what each older season counts against the latest */
  fade = 0.7,
): Formation {
  const latest = rows.reduce((most, r) => Math.max(most, r.season), 0);
  const league = new Map<string, { plays: number; gun: number }>();
  const sides = new Map<string, { plays: number; gun: number }>();

  for (const row of rows) {
    const counts = Math.pow(fade, Math.max(0, latest - row.season));
    const at = band(row.down, row.toGo);
    const all = league.get(at) ?? { plays: 0, gun: 0 };
    all.plays += counts;
    all.gun += counts * row.shotgun;
    league.set(at, all);

    const his = sides.get(row.offence) ?? { plays: 0, gun: 0 };
    his.plays += counts;
    his.gun += counts * row.shotgun;
    sides.set(row.offence, his);
  }

  const everyone = [...sides.values()]
    .reduce((sum, s) => sum + s.gun, 0) /
    Math.max(1, [...sides.values()].reduce((sum, s) => sum + s.plays, 0));
  const leaning = new Map<string, number>();

  for (const [team, his] of sides) {
    if (his.plays < 50 || everyone <= 0) {
      continue;
    }

    // pulled toward one by how much of him there is
    const trust = his.plays / (his.plays + SETTLES_AT);
    leaning.set(team, trust * ((his.gun / his.plays) / everyone) + (1 - trust));
  }

  return {
    learnedFrom: leaning.size,
    leaning: (offence) => (offence ? leaning.get(offence) ?? 1 : 1),
    gunHere: (state, offence) => {
      const here = league.get(band(state.down, state.toGo));
      const base = here && here.plays > 0 ? here.gun / here.plays : 0.6;
      const his = offence ? leaning.get(offence) ?? 1 : 1;

      return Math.max(0.02, Math.min(0.98, base * his));
    },
  };
}
