/**
 * What a side does on fourth down, off the same state as everything
 * else.
 *
 * The old rule read the field in ten yard zones and knew nothing of the
 * score or the clock, and it is what makes the walk settle for three:
 * it kicks on 16.4% of drives where sides really kick on 14.0%, and
 * scores touchdowns on 17.2% where they really score on 23.6%.
 *
 * It is a choice between three things, so it is fitted as one rather
 * than as a coin flip with a kick bolted on.
 */

import { marginBand, timeBand } from "../model/playFactors.js";
import type { PlayState } from "../model/playFactors.js";

export type FourthChoice = "go" | "kick" | "punt";

export interface FourthDown {
  /** the chance of each, adding to one */
  chances: (state: PlayState) => Record<FourthChoice, number>;
  /** one of them, drawn */
  choose: (state: PlayState, uniform: () => number) => FourthChoice;
}

export interface FourthRow {
  toGo: number;
  yardline: number;
  margin: number;
  secondsLeft: number;
  choice: FourthChoice;
}

interface Tally {
  go: number;
  kick: number;
  punt: number;
  all: number;
}

const empty = (): Tally => ({ go: 0, kick: 0, punt: 0, all: 0 });

export function fitFourthDown(rows: FourthRow[], least = 60): FourthDown {
  const cells = new Map<string, Tally>();

  const add = (at: string, choice: FourthChoice) => {
    const cell = cells.get(at) ?? empty();
    cell[choice]++;
    cell.all++;
    cells.set(at, cell);
  };

  for (const row of rows) {
    const spot = `4|${Math.min(40, row.toGo)}|${Math.min(99, row.yardline)}`;
    add(`${spot}|${timeBand(row.secondsLeft)}|${marginBand(row.margin)}`, row.choice);
    add(`${spot}|any`, row.choice);
  }

  const remembered = new Map<string, Tally>();

  const at = (state: PlayState) => {
    const key = `${Math.min(40, state.toGo)}|${Math.min(99, state.yardline)}` +
      `|${timeBand(state.secondsLeft)}|${marginBand(state.margin)}`;
    const already = remembered.get(key);

    if (already) {
      return already;
    }

    /**
     * The clock and the score are let go straight away here, and the
     * field is held tight instead.
     *
     * Where a side is and how far it needs decide this more than
     * anything else: at the two they go 79% of the time and at the
     * thirty they kick. Holding the clock first left too few plays in a
     * cell, so it reached out across the field and picked up the spots
     * where kicking is the whole answer, which had it going 49% of the
     * time on fourth and goal at the two.
     */
    let found = empty();

    for (const reach of [0, 1, 2, 3, 5, 8]) {
      const pooled = empty();

      for (let yard = state.yardline - reach; yard <= state.yardline + reach; yard++) {
        if (yard < 1 || yard > 99) {
          continue;
        }

        const near = Math.min(2, Math.ceil(reach / 2));

        for (let toGo = state.toGo - near; toGo <= state.toGo + near; toGo++) {
          if (toGo < 1 || toGo > 40) {
            continue;
          }

          const cell = cells.get(
            `4|${Math.min(40, toGo)}|${Math.min(99, yard)}|any`,
          );

          if (!cell) {
            continue;
          }

          pooled.go += cell.go;
          pooled.kick += cell.kick;
          pooled.punt += cell.punt;
          pooled.all += cell.all;
        }
      }

      found = pooled;

      if (found.all >= least) {
        break;
      }
    }

    remembered.set(key, found);
    return found;
  };

  const chances = (state: PlayState): Record<FourthChoice, number> => {
    const cell = at(state);

    if (cell.all === 0) {
      // nothing to go on: punt from deep, kick from close
      return state.yardline <= 35
        ? { go: 0.15, kick: 0.7, punt: 0.15 }
        : { go: 0.12, kick: 0, punt: 0.88 };
    }

    return {
      go: cell.go / cell.all,
      kick: cell.kick / cell.all,
      punt: cell.punt / cell.all,
    };
  };

  return {
    chances,
    choose: (state, uniform) => {
      const odds = chances(state);
      let left = uniform();

      for (const choice of ["go", "kick", "punt"] as FourthChoice[]) {
        left -= odds[choice];

        if (left <= 0) {
          return choice;
        }
      }

      return "punt";
    },
  };
}
