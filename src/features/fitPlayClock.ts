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
  /** the gap to the next snap, where one could be worked out */
  took?: number;
}

export interface PlayClock {
  /** seconds from this snap to the next */
  secondsFor: (
    call: Call, yards: number, margin: number, secondsLeft: number,
  ) => number;
  learnedOn: number;
}

interface Tally {
  plays: number;
  seconds: number;
}

const empty = (): Tally => ({ plays: 0, seconds: 0 });

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

export function fitPlayClock(rows: ClockRow[]): PlayClock {
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

  return {
    learnedOn: overall.plays,
    secondsFor: (call, yards, margin, secondsLeft) => {
      const own = byKind.get(keyFor(call, yards, margin, secondsLeft));

      return own && own.plays >= 100 ? own.seconds / own.plays : middle;
    },
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
