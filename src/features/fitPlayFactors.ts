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
  call: Call;
  yards: number;
  touchdown: number;
  /** who had it, empty when the play is only being counted */
  player: string;
}

export interface FactorSettings {
  /** plays needed before a state answers for itself */
  least: number;
  /** touches needed before a man's own share at a state is believed */
  leastForMan: number;
}

export const FACTOR_DEFAULTS: FactorSettings = { least: 300, leastForMan: 40 };

/** everything counted at one state, plus who touched it there */
interface Counted extends StateCell {
  byPlayer: Map<string, { touches: number; yards: number; scores: number }>;
}

const emptyCounted = (): Counted =>
  ({ ...emptyCell(), byPlayer: new Map() });

export function fitPlayFactors(
  rows: PlayRow[],
  settings: FactorSettings = FACTOR_DEFAULTS,
): PlayFactors {
  const cells = new Map<string, Counted>();

  for (const row of rows) {
    const at = stateKey(row.down, row.toGo, row.yardline);
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
  }

  /** the states around this one, taken until there are enough plays */
  const gather = (state: PlayState, least: number) => {
    const pooled = emptyCounted();

    for (const spot of widening(state)) {
      const cell = cells.get(stateKey(state.down, spot.toGo, spot.yardline));

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
    const key = `${stateKey(state.down, state.toGo, state.yardline)}|${least}`;
    const already = remembered.get(key);

    if (already) {
      return already;
    }

    const found = gather(state, least);
    remembered.set(key, found);
    return found;
  };

  return {
    runs: (state) => {
      const cell = at(state, settings.least);
      return cell.plays === 0 ? 0.45 : cell.runs / cell.plays;
    },
    goesTo: (state, call, among) => {
      void call;
      const cell = at(state, settings.leastForMan * Math.max(1, among.length));
      const shares = new Map<string, number>();
      let total = 0;

      for (const player of among) {
        const own = cell.byPlayer.get(player);
        const touches = own ? own.touches : 0;
        shares.set(player, touches);
        total += touches;
      }

      if (total === 0) {
        for (const player of among) shares.set(player, 1 / among.length);
        return shares;
      }

      for (const [player, touches] of shares) shares.set(player, touches / total);

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
