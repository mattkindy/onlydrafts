/**
 * How long a play takes, so a game can run until the clock says stop.
 *
 * A drive count was handed to the walk from a league-wide list, which
 * is a constant standing where two offences should be. What decides
 * how many drives a game has is how fast they work, and that is mostly
 * one thing: a throw nobody caught stops the clock and costs 12
 * seconds where everything else costs 33 to 37.
 *
 * A side behind by two scores plays six seconds a snap faster, and
 * inside two minutes everybody does.
 */

import type { Call } from "../model/playFactors.js";

export interface ClockRow {
  call: Call;
  yards: number;
  margin: number;
  secondsLeft: number;
  /** whose snap it was, since sides differ by two possessions a game */
  offence?: string;
  /** the gap to the next snap, where one could be worked out */
  took?: number;
}

export interface PlayClock {
  /** seconds from this snap to the next */
  secondsFor: (
    call: Call, yards: number, margin: number, secondsLeft: number,
    offence?: string,
  ) => number;
  /** how far from the league a side plays, for anyone who wants to say */
  paceOf: (offence: string) => number;
  learnedOn: number;
}

interface Tally {
  plays: number;
  seconds: number;
}

const empty = (): Tally => ({ plays: 0, seconds: 0 });

/**
 * A scale on the fitted gap between snaps, for experiments only.
 *
 * This sat at 1.06 for three days to keep kicker attempts down, and
 * what it was doing was shrinking the whole game: ten plays and a
 * drive went missing from every one, and two points a side with them.
 * The kick excess it papered over comes from targeted draws gaining
 * too little between the twenties, and gets fixed there.
 */
const BETWEEN_SNAPS = Number(process.env["BETWEEN_SNAPS"] ?? 1.0);

/** two minutes left in either half, when everybody hurries */
const hurrying = (secondsLeft: number) => secondsLeft % 1800 < 120;

/** how far behind a side has to be before it starts hurrying anyway */
const CHASING = -9;

const keyFor = (
  call: Call, yards: number, margin: number, secondsLeft: number,
) => {
  const what = call === "pass" && yards <= 0 ? "incomplete" : call;
  const how = hurrying(secondsLeft) ? "late" : margin <= CHASING ? "behind" : "normal";

  return `${what}|${how}`;
};

/** how much of a side's own tempo survives the staff changing */
export interface StaffKept {
  /** true when the same head coach is still there */
  sameHeadCoach: (offence: string) => boolean;
  /** and the same coordinator */
  sameCoordinator: (offence: string) => boolean;
}

export function fitPlayClock(
  rows: ClockRow[], steadyAt = 400, staff?: StaffKept,
): PlayClock {
  const byKind = new Map<string, Tally>();
  const overall = empty();

  for (const row of rows) {
    if (row.took === undefined || row.took <= 0 || row.took > 120) {
      continue;
    }

    const key = keyFor(row.call, row.yards, row.margin, row.secondsLeft);
    const own = byKind.get(key) ?? empty();
    own.plays++;
    own.seconds += row.took;
    byKind.set(key, own);
    overall.plays++;
    overall.seconds += row.took;
  }

  const middle = overall.plays > 0 ? overall.seconds / overall.plays : 30.5;
  const usual = (call: Call, yards: number, margin: number, secondsLeft: number) => {
    const own = byKind.get(keyFor(call, yards, margin, secondsLeft));

    return own && own.plays >= 100 ? own.seconds / own.plays : middle;
  };

  /**
   * And how far each side runs from that, with what happened on the
   * play held still.
   *
   * A side that throws more has more snaps that stop the clock, so raw
   * seconds a snap would call it quick when it is only incomplete.
   * Measured this way the quickest and the slowest are seventeen
   * seconds apart over a drive, which is two possessions a game, and
   * it carries to the next season at .507.
   */
  const bySide = new Map<string, { plays: number; over: number }>();

  for (const row of rows) {
    if (row.took === undefined || row.took <= 0 || row.took > 120 || !row.offence) {
      continue;
    }

    const own = bySide.get(row.offence) ?? { plays: 0, over: 0 };
    own.plays++;
    own.over += row.took - usual(row.call, row.yards, row.margin, row.secondsLeft);
    bySide.set(row.offence, own);
  }

  /**
   * How much of last year's tempo a side still owns.
   *
   * It carries at .613 when the staff stays, .404 once the
   * coordinator goes and .280 once the head coach does, so tempo is
   * the staff's and mostly the head coach's. What gets called belongs
   * to the coordinator; how fast the operation runs is game
   * management.
   */
  const stillTheirs = (offence: string) => {
    if (!staff) {
      return 1;
    }

    if (!staff.sameHeadCoach(offence)) {
      return 0.28 / 0.613;
    }

    return staff.sameCoordinator(offence) ? 1 : 0.404 / 0.613;
  };

  const paceOf = (offence: string) => {
    const own = bySide.get(offence);

    if (!own || own.plays <= 0) {
      return 0;
    }

    // pulled toward the league until a side has played enough, and
    // again by however much of the staff has gone
    return (own.over / own.plays) *
      (own.plays / (own.plays + steadyAt)) * stillTheirs(offence);
  };

  return {
    learnedOn: overall.plays,
    paceOf,
    secondsFor: (call, yards, margin, secondsLeft, offence) =>
      Math.max(
        4,
        (usual(call, yards, margin, secondsLeft) +
          (offence ? paceOf(offence) : 0)) * BETWEEN_SNAPS,
      ),
  };
}

/**
 * The gap to the next snap, filled in where the two plays belong to
 * the same side in the same game and the clock moved a sensible
 * amount. A change of possession or a half ending leaves it out.
 */
export function timeBetween<T extends {
  season: number; week: number; offence: string; secondsLeft: number;
}>(plays: T[]): (T & { took?: number })[] {
  const out = plays as (T & { took?: number })[];

  for (let i = 0; i < out.length - 1; i++) {
    const now = out[i]!;
    const next = out[i + 1]!;

    if (
      now.season !== next.season || now.week !== next.week ||
      now.offence !== next.offence
    ) {
      continue;
    }

    const took = now.secondsLeft - next.secondsLeft;

    if (took > 0 && took <= 120) {
      now.took = took;
    }
  }

  return out;
}
