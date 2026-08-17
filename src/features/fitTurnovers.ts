/**
 * How often a play is given away, off the state like everything else.
 *
 * The walk uses one number per kind of play, which puts turnovers on
 * 11.8% of drives where sides really lose it on 10.1%. A throw on third
 * and fifteen is not a hand-off on first and ten, and a flat rate
 * cannot say so.
 *
 * Fitting it this way moved the drive rate from 11.8% to 11.6% against
 * the 10.1% wanted, so it is not wired into the walk. Kept because the
 * measurement is worth more than the file costs: the excess is not in
 * how the rate varies with the state.
 */

import { marginBand, timeBand } from "../model/playFactors.js";
import type { Call, PlayState } from "../model/playFactors.js";

export interface Turnovers {
  rate: (state: PlayState, call: Call) => number;
}

export interface TurnoverRow {
  down: number;
  toGo: number;
  yardline: number;
  margin: number;
  secondsLeft: number;
  call: Call;
  lost: number;
}

interface Tally {
  lost: number;
  all: number;
}

export function fitTurnovers(rows: TurnoverRow[], least = 400): Turnovers {
  const cells = new Map<string, Tally>();

  const add = (at: string, lost: number) => {
    const cell = cells.get(at) ?? { lost: 0, all: 0 };
    cell.all++;
    cell.lost += lost;
    cells.set(at, cell);
  };

  for (const row of rows) {
    const spot = `${row.call}|${Math.min(4, row.down)}|${Math.min(30, row.toGo)}`;
    add(`${spot}|${Math.min(99, row.yardline)}`, row.lost);
    add(`${spot}|any`, row.lost);
  }

  const remembered = new Map<string, number>();

  return {
    rate: (state, call) => {
      const key = `${call}|${state.down}|${Math.min(30, state.toGo)}` +
        `|${Math.min(99, state.yardline)}`;
      const already = remembered.get(key);

      if (already !== undefined) {
        return already;
      }

      const spot = `${call}|${Math.min(4, state.down)}|${Math.min(30, state.toGo)}`;
      let found = { lost: 0, all: 0 };

      // the same distance at nearby spots first, then any spot at all
      for (const reach of [2, 5, 10, 20]) {
        const pooled = { lost: 0, all: 0 };

        for (let yard = state.yardline - reach; yard <= state.yardline + reach; yard++) {
          if (yard < 1 || yard > 99) {
            continue;
          }

          const cell = cells.get(`${spot}|${yard}`);

          if (cell) {
            pooled.lost += cell.lost;
            pooled.all += cell.all;
          }
        }

        found = pooled;

        if (found.all >= least) {
          break;
        }
      }

      if (found.all < least) {
        found = cells.get(`${spot}|any`) ?? found;
      }

      const rate = found.all === 0 ? 0.02 : found.lost / found.all;
      remembered.set(key, rate);
      return rate;
    },
  };
}
