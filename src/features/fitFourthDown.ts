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

import { holdsDistance, marginBand, timeBand } from "../model/playFactors.js";
import type { PlayState } from "../model/playFactors.js";

export type FourthChoice = "go" | "kick" | "punt";

/**
 * How far along the field to reach for more plays.
 *
 * Kicking falls off a cliff at the forty, where a field goal becomes
 * fifty seven yards: sides kick on 55% of fourth downs from the thirty
 * to the forty and 4% from the forty to the fifty. Reaching eight
 * yards either way steps over that and the model punted 19% from the
 * thirty to the forty where sides punt 11%.
 */
const REACHES = [0, 1, 2, 3];

/**
 * How far along the distance to reach. Letting it out with the field
 * pooled fourth and one with fourth and three from the second step, and
 * the walk went 61% at one and 41% at three; from four to five a yard
 * still moves the answer a little, and past that hardly at all.
 */
export const distanceReach = (toGo: number, reach: number): number => {
  if (holdsDistance(toGo)) {
    return 0;
  }

  if (toGo <= 5) {
    return Math.min(1, reach);
  }

  return Math.min(2, Math.ceil(reach / 2));
};

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
  /** which season it came from, so the older ones can count for less */
  season?: number;
}

interface Tally {
  go: number;
  kick: number;
  punt: number;
  all: number;
}

const empty = (): Tally => ({ go: 0, kick: 0, punt: 0, all: 0 });

/**
 * `steadyAt` is how much of a band's own answer to keep, and it is low
 * because the bands that matter are the thin ones. At forty the last
 * two minutes came out at 23.5% against the 50.6% sides really go, and
 * at six it comes out at 33.8% while the common band gives up under
 * two points. `fades` would count older seasons for less, and it is
 * off: it thins the rare bands, which makes the blend trust them less,
 * which is the opposite of what it was for.
 */
/**
 * How much to lift going for it, for a model fitted on earlier
 * seasons and asked about a later one.
 *
 * Sides went for it on 18.7% of fourth downs in 2022, 19.4% in 2023,
 * 20.1% in 2024 and 22.7% in 2025, so it climbs about 3.6% a year and
 * jumped harder than that once. A model fitted flat over several
 * seasons sits in the middle of them and guesses at the middle of a
 * climb.
 */
export function climbTo(learn: number[], target: number, byYear = 1.036): number {
  if (!learn.length) {
    return 1;
  }

  const middleOf = learn.reduce((a, b) => a + b, 0) / learn.length;

  return Math.pow(byYear, Math.max(0, target - middleOf));
}

export function fitFourthDown(
  rows: FourthRow[], least = 60, steadyAt = 2, fades = 1, lift = 1,
): FourthDown {
  const cells = new Map<string, Tally>();

  const add = (at: string, choice: FourthChoice, weight: number) => {
    const cell = cells.get(at) ?? empty();
    cell[choice] += weight;
    cell.all += weight;
    cells.set(at, cell);
  };

  /**
   * A season back counts for less than the one before it.
   *
   * Going for it has climbed every year for a decade, so a model
   * fitted flat over four seasons is guessing at the middle of a
   * climb. Sides went for it on 76% of fourth and short inside the ten
   * in 2025 against 56% the year before.
   */
  const latest = rows.reduce((most, row) => Math.max(most, row.season ?? 0), 0);
  const worth = (season?: number) =>
    season === undefined || latest === 0 ? 1 : Math.pow(fades, latest - season);

  for (const row of rows) {
    const spot = `4|${Math.min(40, row.toGo)}|${Math.min(99, row.yardline)}`;
    const weight = worth(row.season);
    add(
      `${spot}|${timeBand(row.secondsLeft)}|${marginBand(row.margin)}`,
      row.choice, weight,
    );
    add(`${spot}|any`, row.choice, weight);
  }

  /** the same cell with the score let go by one band either way */
  const nearKeys = (spot: string, time: number, band: number) => {
    const bands = [band - 1, band, band + 1].filter((b) => b >= 0 && b <= 8);

    return bands.map((b) => `${spot}|${time}|${b}`);
  };

  const remembered = new Map<string, Tally>();

  const at = (state: PlayState) => {
    const key = `${Math.min(40, state.toGo)}|${Math.min(99, state.yardline)}` +
      `|${timeBand(state.secondsLeft)}|${marginBand(state.margin)}`;
    const already = remembered.get(key);

    if (already) {
      return already;
    }

    /**
     * The field is widened over first and the clock and the score are
     * only let go once it has run out of room.
     *
     * Where a side is and how far it needs decide this more than
     * anything else: at the two they go 79% of the time and at the
     * thirty they kick. But dropping the clock and the score at the
     * first step, which is what this used to do, threw them away
     * everywhere, and the answer came out about 20% whatever the game
     * was, where a side two scores behind goes 55.7% and one inside
     * two minutes 50.6%.
     */
    const time = timeBand(state.secondsLeft);
    const band = marginBand(state.margin);
    const keysFor = (spot: string, level: number) =>
      level === 0 ? [`${spot}|${time}|${band}`]
        : level === 1 ? nearKeys(spot, time, band)
        : [`${spot}|any`];
    const gathered: Tally[] = [];

    for (const level of [0, 1, 2]) {
      let found = empty();

      for (const reach of REACHES) {
        const pooled = empty();

        for (
          let yard = state.yardline - reach; yard <= state.yardline + reach; yard++
        ) {
          if (yard < 1 || yard > 99) {
            continue;
          }

          const near = distanceReach(state.toGo, reach);

          for (let toGo = state.toGo - near; toGo <= state.toGo + near; toGo++) {
            if (toGo < 1 || toGo > 40) {
              continue;
            }

            const spot = `4|${Math.min(40, toGo)}|${Math.min(99, yard)}`;

            for (const at of keysFor(spot, level)) {
              const cell = cells.get(at);

              if (!cell) {
                continue;
              }

              pooled.go += cell.go;
              pooled.kick += cell.kick;
              pooled.punt += cell.punt;
              pooled.all += cell.all;
            }
          }
        }

        found = pooled;

        if (found.all >= least) {
          break;
        }
      }

      gathered.push(found);
    }

    /**
     * What the game says, pulled toward what the spot says.
     *
     * Only 283 fourth downs all season happen between five minutes and
     * two, so widening within that band runs out of field before it
     * has enough and used to give up on the band entirely. Each level
     * is trusted for what it saw and hands the rest down: the exact
     * band first, then the score a band either way, then any game at
     * this spot.
     */
    const mixed = empty();

    for (const choice of ["go", "kick", "punt"] as FourthChoice[]) {
      let ever = 0;

      for (const found of [...gathered].reverse()) {
        if (found.all === 0) {
          continue;
        }

        const trust = found.all / (found.all + steadyAt);
        ever = trust * (found[choice] / found.all) + (1 - trust) * ever;
      }

      mixed[choice] = ever;
      mixed.all += ever;
    }

    /**
     * And lifted, since going for it climbs every year and this was
     * fitted on the seasons before the one being asked about.
     */
    const found = empty();
    const wanted = Math.min(0.98, mixed.go * lift);
    const rest = mixed.kick + mixed.punt;
    found.go = wanted;
    found.kick = rest > 0 ? mixed.kick * (1 - wanted) / rest : 0;
    found.punt = rest > 0 ? mixed.punt * (1 - wanted) / rest : 1 - wanted;
    found.all = found.go + found.kick + found.punt;

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
