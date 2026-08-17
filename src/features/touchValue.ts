/**
 * What a touch is worth from where it happens.
 *
 * The four situations average a 44% chance of scoring on the two yard
 * line together with 7.5% from the eighteen, and hand both the same
 * number. Down and distance go the same way: a back takes 17% of the
 * work on third and seven and 39% on third and twenty, and the bucket
 * calls those one thing.
 *
 * Nothing is bucketed here. Yards and scores are read off the state
 * itself, smoothed only as far as the counts require.
 */

export interface TouchState {
  down: number;
  toGo: number;
  /** yards from the opponent's goal line */
  yardline: number;
  type: "run" | "pass";
}

export interface TouchValue {
  /** how often a touch from here ends in the end zone */
  scores: (state: TouchState) => number;
  /** what it gains */
  yards: (state: TouchState) => number;
  /** and the two together, as points under a scoring */
  points: (state: TouchState, perYard: number, perScore: number) => number;
}

interface Cell {
  plays: number;
  scores: number;
  yards: number;
}

const key = (down: number, toGo: number, yardline: number, type: string) =>
  `${type}|${Math.min(4, down)}|${Math.min(20, toGo)}|${Math.min(99, yardline)}`;

/**
 * Averages over a widening window until enough plays are in it, so a
 * spot with plenty of history keeps its own number and a thin one
 * borrows from its neighbours rather than from a bucket average.
 */
function around(
  cells: Map<string, Cell>,
  state: TouchState,
  least: number,
): Cell {
  const total: Cell = { plays: 0, scores: 0, yards: 0 };

  for (const reach of [0, 1, 2, 3, 5, 8, 12, 20, 40]) {
    total.plays = 0;
    total.scores = 0;
    total.yards = 0;

    for (let yard = state.yardline - reach; yard <= state.yardline + reach; yard++) {
      if (yard < 1 || yard > 99) {
        continue;
      }

      const toGoReach = Math.ceil(reach / 2);

      for (let toGo = state.toGo - toGoReach; toGo <= state.toGo + toGoReach; toGo++) {
        if (toGo < 1) {
          continue;
        }

        const cell = cells.get(key(state.down, toGo, yard, state.type));

        if (!cell) {
          continue;
        }

        total.plays += cell.plays;
        total.scores += cell.scores;
        total.yards += cell.yards;
      }
    }

    if (total.plays >= least) {
      return total;
    }
  }

  return total;
}

export interface TouchRow {
  down: number;
  toGo: number;
  yardline: number;
  type: string;
  yards: number;
  touchdown: number;
}

export function fitTouchValue(rows: TouchRow[], least = 400): TouchValue {
  const cells = new Map<string, Cell>();

  for (const row of rows) {
    if (row.type !== "run" && row.type !== "pass") {
      continue;
    }

    const at = key(row.down, row.toGo, row.yardline, row.type);
    const cell = cells.get(at) ?? { plays: 0, scores: 0, yards: 0 };
    cell.plays++;
    cell.scores += row.touchdown;
    cell.yards += row.yards;
    cells.set(at, cell);
  }

  const look = new Map<string, Cell>();
  const seen = (state: TouchState) => {
    const at = key(state.down, state.toGo, state.yardline, state.type);
    const already = look.get(at);

    if (already) {
      return already;
    }

    const found = around(cells, state, least);
    look.set(at, found);
    return found;
  };

  return {
    scores: (state) => {
      const cell = seen(state);
      return cell.plays === 0 ? 0.05 : cell.scores / cell.plays;
    },
    yards: (state) => {
      const cell = seen(state);
      return cell.plays === 0 ? 4 : cell.yards / cell.plays;
    },
    points: (state, perYard, perScore) => {
      const cell = seen(state);

      if (cell.plays === 0) {
        return 4 * perYard + 0.05 * perScore;
      }

      return (cell.yards / cell.plays) * perYard +
        (cell.scores / cell.plays) * perScore;
    },
  };
}
