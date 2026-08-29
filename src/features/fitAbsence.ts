/**
 * Missing games as a process rather than a discount.
 *
 * A season's absences arrive in spells: a man goes down with some
 * weekly chance and stays down for a drawn stretch. Playing seasons
 * with that process in them prices availability exactly once, lets a
 * backup inherit the work for the weeks it lasts, and puts long
 * correlated absences into the season's spread, which a weekly coin
 * cannot do. Fitted from played weeks, not injury reports: a man with
 * a steady role who vanishes for three weeks was absent, whatever the
 * report said, and men without a steady role are left out since a
 * healthy scratch looks identical to an injury from here.
 */

import { loadPlayerStats } from "../data/nflverse.js";

export interface Absence {
  /** the chance a playing man starts a spell this week, by position */
  hazardOf: (position: string) => number;
  /** a spell's length in weeks, drawn */
  spellOf: (position: string, uniform: () => number) => number;
  /**
   * The same process scaled to one man: the league's hazard moved so
   * his expected games match what the availability model says of him.
   */
  hazardFor: (position: string, expectedGames: number, playable: number) => number;
}

const POSITIONS = ["QB", "RB", "WR", "TE"];
/** a man counts toward the fit once he averages this many touches */
const STEADY = 5;

export async function fitAbsence(seasons: number[]): Promise<Absence> {
  const spells = new Map<string, number[]>();
  const starts = new Map<string, number>();
  const playingWeeks = new Map<string, number>();

  for (const season of seasons) {
    const weeksOf = new Map<string, Set<number>>();
    const touches = new Map<string, number>();
    const position = new Map<string, string>();
    const teamWeeks = new Map<string, Set<number>>();
    const teamOf = new Map<string, string>();

    for (const s of await loadPlayerStats(season)) {
      if (s.week > 18 || !POSITIONS.includes(s.position)) {
        continue;
      }

      const weeks = weeksOf.get(s.playerId) ?? new Set<number>();
      weeks.add(s.week);
      weeksOf.set(s.playerId, weeks);
      touches.set(
        s.playerId,
        (touches.get(s.playerId) ?? 0) +
          (s.carries ?? 0) + (s.targets ?? 0) + (s.passing?.attempts ?? 0),
      );
      position.set(s.playerId, s.position);
      teamOf.set(s.playerId, s.teamId);
      const team = teamWeeks.get(s.teamId) ?? new Set<number>();
      team.add(s.week);
      teamWeeks.set(s.teamId, team);
    }

    for (const [playerId, weeks] of weeksOf) {
      const played = weeks.size;

      if ((touches.get(playerId) ?? 0) < STEADY * played) {
        continue;
      }

      const pos = position.get(playerId)!;
      const schedule = [...(teamWeeks.get(teamOf.get(playerId)!) ?? [])]
        .sort((a, b) => a - b);
      const first = Math.min(...weeks);
      const last = Math.max(...weeks);
      let out = 0;

      /**
       * Only the stretch between his first and last appearance: what
       * comes before is a holdout or a role not yet won, what comes
       * after may be shutdown or release, and neither is the injury
       * this draws.
       */
      for (const week of schedule) {
        if (week < first || week > last) {
          continue;
        }

        if (weeks.has(week)) {
          if (out > 0) {
            spells.set(pos, [...(spells.get(pos) ?? []), out]);
            out = 0;
          }

          playingWeeks.set(pos, (playingWeeks.get(pos) ?? 0) + 1);
        } else {
          if (out === 0) {
            starts.set(pos, (starts.get(pos) ?? 0) + 1);
          }

          out++;
        }
      }
    }
  }

  const hazardOf = (pos: string) =>
    (starts.get(pos) ?? 0) / Math.max(1, playingWeeks.get(pos) ?? 0);
  const spellOf = (pos: string, uniform: () => number) => {
    const pool = spells.get(pos) ?? [1];

    return pool[Math.min(pool.length - 1, Math.floor(uniform() * pool.length))]!;
  };

  return {
    hazardOf,
    spellOf,
    hazardFor: (pos, expectedGames, playable) => {
      const league = hazardOf(pos);
      const pool = spells.get(pos) ?? [1];
      const meanSpell = pool.reduce((a, b) => a + b, 0) / Math.max(1, pool.length);
      const hisMissed = Math.max(0.2, playable - expectedGames);
      /**
       * Expected misses are roughly hazard times spell length times
       * the weeks he is up, so his hazard is the league's scaled to
       * land his expectation, kept inside sane walls.
       */
      const wanted = hisMissed / Math.max(1, meanSpell * playable);

      return Math.max(0.005, Math.min(0.25, wanted, league * 6));
    },
  };
}
