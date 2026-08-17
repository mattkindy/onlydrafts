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
  emptyCell, keysAt, stateKey, widening,
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
  byPlayer: Map<string, {
    touches: number; yards: number; scores: number;
    /** and how often he breaks a long one, which is his own and lasts */
    long: number;
  }>;
  /**
   * Where each gain came from, since a gain is cut off by the goal
   * line. A play from the forty one cannot make more than forty one
   * yards, so pooling it in with the forty five caps what a draw there
   * can produce and halves the long scores.
   */
  from: number[];
}

const emptyCounted = (): Counted =>
  ({ ...emptyCell(), byPlayer: new Map(), from: [] });

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
    // Keyed by the call as well. A run and a pass from the same spot
    // gain differently, 4.5 yards against 6.1 with a far fatter tail,
    // and go to different men. Pooling them meant the call decided
    // nothing at all.
    const at = `${row.call}|` + stateKey(
      row.down, row.toGo, row.yardline, row.secondsLeft, row.margin,
    );
    // and the same play again under any clock and any score, so a thin
    // state can fall back to the spot itself
    const loose = `${row.call}|${Math.min(4, row.down)}|${Math.min(40, row.toGo)}` +
      `|${Math.min(99, row.yardline)}|any`;
    // and once more without the call, because how often a side runs has
    // to come from one cell counting both. Widening a run pool and a
    // pass pool separately until each has enough finds eighty of each
    // wherever it must, and the answer is fifty percent every time.
    const eitherWay = stateKey(
      row.down, row.toGo, row.yardline, row.secondsLeft, row.margin,
    );
    const eitherLoose =
      `${Math.min(4, row.down)}|${Math.min(40, row.toGo)}` +
      `|${Math.min(99, row.yardline)}|any`;
    const cell = cells.get(at) ?? emptyCounted();
    cell.plays++;
    if (row.call === "run") cell.runs++;
    cell.yards.push(row.yards);
    cell.from.push(row.yardline);
    cell.scores += row.touchdown;

    if (row.player) {
      const own = cell.byPlayer.get(row.player) ??
        { touches: 0, yards: 0, scores: 0, long: 0 };
      own.touches++;
      own.yards += row.yards;
      own.scores += row.touchdown;
      if (row.yards >= 20) own.long++;
      cell.byPlayer.set(row.player, own);
    }

    cells.set(at, cell);

    const anyTime = cells.get(loose) ?? emptyCounted();
    anyTime.plays++;
    if (row.call === "run") anyTime.runs++;
    anyTime.yards.push(row.yards);
    anyTime.from.push(row.yardline);
    anyTime.scores += row.touchdown;

    if (row.player) {
      const own = anyTime.byPlayer.get(row.player) ??
        { touches: 0, yards: 0, scores: 0, long: 0 };
      own.touches++;
      own.yards += row.yards;
      own.scores += row.touchdown;
      if (row.yards >= 20) own.long++;
      anyTime.byPlayer.set(row.player, own);
    }

    cells.set(loose, anyTime);

    for (const key of [eitherWay, eitherLoose]) {
      const both = cells.get(key) ?? emptyCounted();
      both.plays++;
      if (row.call === "run") both.runs++;
      cells.set(key, both);
    }
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
  const gather = (
    state: PlayState, least: number, looseness: number, call?: Call,
  ) => {
    const pooled = emptyCounted();

    for (const spot of widening(state)) {
      if (spot.looseness !== looseness) {
        continue;
      }

      for (const at of keysAt(
        state.down, spot.toGo, spot.yardline,
        state.secondsLeft, state.margin, looseness,
      )) {
      const cell = cells.get(call ? `${call}|${at}` : at);

      if (!cell) {
        continue;
      }

      pooled.plays += cell.plays;
      pooled.runs += cell.runs;
      pooled.scores += cell.scores;
      pooled.yards = pooled.yards.concat(cell.yards);
      pooled.from = pooled.from.concat(cell.from);

      for (const [player, own] of cell.byPlayer) {
        const already = pooled.byPlayer.get(player) ??
          { touches: 0, yards: 0, scores: 0, long: 0 };
        already.touches += own.touches;
        already.yards += own.yards;
        already.scores += own.scores;
        already.long += own.long;
        pooled.byPlayer.set(player, already);
      }

      }

      if (pooled.plays >= least) {
        break;
      }
    }

    return pooled;
  };

  const remembered = new Map<string, Counted>();
  const at = (state: PlayState, least: number, call?: Call) => {
    const key = `${call ?? "both"}|${stateKey(
      state.down, state.toGo, state.yardline, state.secondsLeft, state.margin,
    )}|${least}`;
    const already = remembered.get(key);

    if (already) {
      return already;
    }

    let found = gather(state, least, 0, call);

    for (const looseness of [1, 2]) {
      if (found.plays >= least) {
        break;
      }

      found = gather(state, least, looseness, call);
    }
    remembered.set(key, found);
    return found;
  };

  return {
    runs: (state) => {
      const cell = at(state, settings.leastForCall);
      return cell.plays === 0 ? 0.45 : cell.runs / cell.plays;
    },
    goesTo: (state, call, among) => {
      const cell = at(
        state, settings.leastForMan * Math.max(1, among.length), call,
      );
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
      const cell = at(state, settings.least, call);
      const own = cell.byPlayer.get(player);
      const pool = cell.yards;

      if (!pool.length) {
        return 4;
      }

      /**
       * Whether this is one of his long ones is decided first, from how
       * often he breaks them, and the yards are then drawn from that
       * end of the pool.
       *
       * Scaling every draw by what he averages gives a possession
       * receiver and a deep threat the same shape when they average the
       * same. Breaking a twenty runs from 1.5% of touches to 14.7%
       * across men, lasts from season to season at .755, and is mostly
       * not what his average already says, .684 of it surviving once
       * the average is taken out.
       */
      const enough = own && own.touches >= settings.leastForMan;
      const longOnes: number[] = [];
      const shortOnes: number[] = [];

      for (const gained of pool) {
        (gained >= 20 ? longOnes : shortOnes).push(gained);
      }

      const leagueLong = longOnes.length / Math.max(1, pool.length);
      const hisLong = enough ? own!.long / own!.touches : leagueLong;
      const from = uniform() < hisLong && longOnes.length ? longOnes
        : shortOnes.length ? shortOnes : pool;
      const drawn = from[Math.floor(uniform() * from.length)]!;

      if (!enough || drawn <= 0) {
        return drawn;
      }

      // and his level on top, against what the same men made from here
      const league = cell.yards.reduce((a, b) => a + b, 0) / cell.plays;
      const his = own!.yards / own!.touches;
      const shape = leagueLong > 0 && hisLong > 0
        ? (his / Math.max(0.1, league)) *
          (leagueLong / hisLong) ** 0.5
        : his / Math.max(0.1, league);

      return drawn * Math.max(0.5, Math.min(1.8, shape));
    },
    scores: (state, call, gained) => {
      if (state.yardline - gained <= 0) {
        return 1;
      }

      const cell = at(state, settings.least, call);
      return cell.plays === 0 ? 0 : cell.scores / cell.plays;
    },
  };
}
