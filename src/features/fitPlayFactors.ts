/**
 * The play factors, counted against the exact state and widened only
 * when a question is asked of a thin one.
 *
 * Storing by bucket decides in advance what resolution every question
 * gets. Storing by state and widening on demand lets the goal line keep
 * its own numbers, where the counts are large, while fourth and
 * nineteen at the forty seven borrows from around it.
 */

import {
  emptyCell, stateKey, widening,
  type Call, type PlayFactors, type PlayState, type StateCell,
} from "../model/playFactors.js";

export interface PlayRow {
  down: number;
  toGo: number;
  yardline: number;
  /** this team's lead, and the clock, which move what a coach calls */
  margin: number;
  secondsLeft: number;
  call: Call;
  yards: number;
  touchdown: number;
  /** who had it, empty when the play is only being counted */
  player: string;
}

export interface FactorSettings {
  /** plays needed before a state speaks for itself */
  least: number;
  /**
   * And how many the call needs, which is fewer. A run rate is one
   * number and eighty plays place it within about six points; a
   * distribution of yards wants far more. Asking both for three
   * hundred meant no state ever had enough under its own clock and
   * score, so the call never moved with the game.
   */
  leastForCall: number;
  /** touches needed before a man's own share at a state is believed */
  leastForMan: number;
}

export const FACTOR_DEFAULTS: FactorSettings = {
  least: 300, leastForCall: 80, leastForMan: 40,
};

/** everything counted at one state, plus who touched it there */
interface Counted extends StateCell {
  byPlayer: Map<string, { touches: number; yards: number; scores: number }>;
}

const emptyCounted = (): Counted =>
  ({ ...emptyCell(), byPlayer: new Map() });

/**
 * What share of his offence's work each man is expected to take.
 *
 * Left out, the factors divide the work by what each man did before,
 * which is the weakest way we have of guessing a share: .596 against
 * .747 for working it out from who he is competing with. Passed in,
 * that model sets how much a man gets and the history only says where
 * he gets it.
 */
export type ProjectedShares = Map<string, number>;

export function fitPlayFactors(
  rows: PlayRow[],
  settings: FactorSettings = FACTOR_DEFAULTS,
  projected?: ProjectedShares,
): PlayFactors {
  const cells = new Map<string, Counted>();
  // how much of the ball each man took overall, so his usage at one
  // state can be read as a leaning rather than a level
  const overall = new Map<string, number>();
  let everyTouch = 0;

  for (const row of rows) {
    if (row.player) {
      overall.set(row.player, (overall.get(row.player) ?? 0) + 1);
      everyTouch++;
    }
  }

  for (const row of rows) {
    const at = stateKey(
      row.down, row.toGo, row.yardline, row.secondsLeft, row.margin,
    );
    // and the same play again under any clock and any score, so a thin
    // state can fall back to the spot itself
    const loose = stateKey(row.down, row.toGo, row.yardline);
    const cell = cells.get(at) ?? emptyCounted();
    cell.plays++;
    if (row.call === "run") cell.runs++;
    cell.yards.push(row.yards);
    cell.scores += row.touchdown;

    if (row.player) {
      const own = cell.byPlayer.get(row.player) ??
        { touches: 0, yards: 0, scores: 0 };
      own.touches++;
      own.yards += row.yards;
      own.scores += row.touchdown;
      cell.byPlayer.set(row.player, own);
    }

    cells.set(at, cell);

    const anyTime = cells.get(loose) ?? emptyCounted();
    anyTime.plays++;
    if (row.call === "run") anyTime.runs++;
    anyTime.yards.push(row.yards);
    anyTime.scores += row.touchdown;

    if (row.player) {
      const own = anyTime.byPlayer.get(row.player) ??
        { touches: 0, yards: 0, scores: 0 };
      own.touches++;
      own.yards += row.yards;
      own.scores += row.touchdown;
      anyTime.byPlayer.set(row.player, own);
    }

    cells.set(loose, anyTime);
  }

  /**
   * The states around this one, taken until there are enough plays.
   *
   * The clock and the score are held first, and if this spot cannot
   * answer for itself under them the whole thing starts again with them
   * let go. Carrying the tight counts into the loose pass would add the
   * any-time cells on top of them, and those contain the tight ones, so
   * the game situation would be swamped every time.
   */
  const gather = (state: PlayState, least: number, loose: boolean) => {
    const pooled = emptyCounted();

    for (const spot of widening(state)) {
      if (spot.loose !== loose) {
        continue;
      }

      const cell = cells.get(
        loose
          ? stateKey(state.down, spot.toGo, spot.yardline)
          : stateKey(
              state.down, spot.toGo, spot.yardline,
              state.secondsLeft, state.margin,
            ),
      );

      if (!cell) {
        continue;
      }

      pooled.plays += cell.plays;
      pooled.runs += cell.runs;
      pooled.scores += cell.scores;
      pooled.yards = pooled.yards.concat(cell.yards);

      for (const [player, own] of cell.byPlayer) {
        const already = pooled.byPlayer.get(player) ??
          { touches: 0, yards: 0, scores: 0 };
        already.touches += own.touches;
        already.yards += own.yards;
        already.scores += own.scores;
        pooled.byPlayer.set(player, already);
      }

      if (pooled.plays >= least) {
        break;
      }
    }

    return pooled;
  };

  const remembered = new Map<string, Counted>();
  const at = (state: PlayState, least: number) => {
    const key = `${stateKey(
      state.down, state.toGo, state.yardline, state.secondsLeft, state.margin,
    )}|${least}`;
    const already = remembered.get(key);

    if (already) {
      return already;
    }

    const tight = gather(state, least, false);
    const found = tight.plays >= least ? tight : gather(state, least, true);
    remembered.set(key, found);
    return found;
  };

  return {
    runs: (state) => {
      const cell = at(state, settings.leastForCall);
      return cell.plays === 0 ? 0.45 : cell.runs / cell.plays;
    },
    goesTo: (state, call, among) => {
      void call;
      const cell = at(state, settings.leastForMan * Math.max(1, among.length));
      const here = [...cell.byPlayer.values()].reduce((a, o) => a + o.touches, 0);
      const shares = new Map<string, number>();
      let total = 0;

      for (const player of among) {
        const own = cell.byPlayer.get(player);
        const touches = own ? own.touches : 0;

        if (!projected) {
          shares.set(player, touches);
          total += touches;
          continue;
        }

        // How much more of the work he takes here than he takes in
        // general. A man used on third down leans that way whatever his
        // overall share turns out to be next season.
        const hisOverall = (overall.get(player) ?? 0) / Math.max(1, everyTouch);
        const hisHere = here > 0 ? touches / here : 0;
        const leaning = hisOverall > 0 && hisHere > 0
          ? hisHere / hisOverall
          : 1;
        const weight = (projected.get(player) ?? 0) * leaning;
        shares.set(player, weight);
        total += weight;
      }

      if (total === 0) {
        for (const player of among) shares.set(player, 1 / among.length);
        return shares;
      }

      for (const [player, weight] of shares) shares.set(player, weight / total);

      return shares;
    },
    gains: (state, call, player, uniform) => {
      void call;
      const cell = at(state, settings.least);
      const own = cell.byPlayer.get(player);
      const pool = cell.yards;

      if (!pool.length) {
        return 4;
      }

      const drawn = pool[Math.floor(uniform() * pool.length)]!;

      // his own rate against what a play from here gains, believed in
      // proportion to how often he has been the one taking it
      if (!own || own.touches < settings.leastForMan || drawn <= 0) {
        return drawn;
      }

      const league = cell.yards.reduce((a, b) => a + b, 0) / cell.plays;
      const his = own.yards / own.touches;

      return league <= 0 ? drawn : drawn * (his / league);
    },
    scores: (state, call, gained) => {
      void call;

      if (state.yardline - gained <= 0) {
        return 1;
      }

      const cell = at(state, settings.least);
      return cell.plays === 0 ? 0 : cell.scores / cell.plays;
    },
  };
}
