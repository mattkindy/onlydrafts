/**
 * What a side does with the point after a touchdown: kick it, or go
 * for two, off the score the six put up and the clock.
 *
 * A touchdown used to score a flat 7. NFL sides miss about 5% of
 * extra points and go for two on roughly 9 to 10% of touchdowns, and
 * both turn on the margin right after the six far more than on
 * anything else: a side down 2 goes 81% of the time, where down 4
 * kicks nearly every time. The chance climbs again inside the last
 * five minutes, when the same margins carry more weight.
 *
 * `scripts/twoPointEval.ts` prints the numbers this is fitted from.
 */

export interface AfterTouchdownRow {
  /** the score differential with the six already on the board */
  margin: number;
  secondsLeft: number;
  /** whether the side went for two rather than kicking */
  two: boolean;
  /** whether the attempt, whichever it was, succeeded */
  made: boolean;
}

export interface AfterTouchdown {
  /** the chance of going for two rather than kicking, at this margin and clock */
  goesForTwo: (margin: number, secondsLeft: number) => number;
  /** how often a two point try succeeds, once taken */
  convertRate: number;
  /** how often the kick is good */
  extraPointRate: number;
}

/** seconds left counted as "late", where the same margin is chased harder */
const LATE = 300;
/** fewest tries before a margin's own rate is trusted over the pooled one */
const LEAST = 40;
/** the same, for the late table, which has far fewer tries to draw on */
const LEAST_LATE = 15;

interface Tally {
  two: number;
  all: number;
}

function tally(rows: AfterTouchdownRow[], late: boolean): Map<number, Tally> {
  const byMargin = new Map<number, Tally>();

  for (const row of rows) {
    if (late && row.secondsLeft > LATE) {
      continue;
    }

    const cell = byMargin.get(row.margin) ?? { two: 0, all: 0 };
    cell.all++;
    if (row.two) cell.two++;
    byMargin.set(row.margin, cell);
  }

  return byMargin;
}

/**
 * Fits the decision, and the two rates around it, off a side's own
 * tries: what it did after the six, and whether the kick or the try
 * that followed was good.
 */
export function fitAfterTouchdown(rows: AfterTouchdownRow[]): AfterTouchdown {
  const overall = tally(rows, false);
  const late = tally(rows, true);
  const allTwo = rows.filter((r) => r.two).length;
  const madeExtra = rows.filter((r) => !r.two && r.made).length;
  const allExtra = rows.filter((r) => !r.two).length;
  const madeTwo = rows.filter((r) => r.two && r.made).length;
  const overallRate = rows.length > 0 ? allTwo / rows.length : 0.095;
  const convertRate = allTwo > 0 ? madeTwo / allTwo : 0.474;
  const extraPointRate = allExtra > 0 ? madeExtra / allExtra : 0.952;

  const rateAt = (table: Map<number, Tally>, margin: number, least: number) => {
    const cell = table.get(margin);
    return cell && cell.all >= least ? cell.two / cell.all : undefined;
  };

  const goesForTwo = (margin: number, secondsLeft: number): number => {
    if (secondsLeft <= LATE) {
      const lateRate = rateAt(late, margin, LEAST_LATE);

      if (lateRate !== undefined) {
        return lateRate;
      }
    }

    return rateAt(overall, margin, LEAST) ?? overallRate;
  };

  return { goesForTwo, convertRate, extraPointRate };
}

/**
 * The fit above, run once on 2022 to 2025 and kept as a constant, the
 * way `AT_HOME` and `CLOCK_DEFAULTS` are. `scripts/twoPointEval.ts`
 * measures these same counts against those seasons.
 */
const OVERALL: [number, number, number][] = [
  [-15, 0.017, 59], [-11, 0.106, 85], [-8, 0.194, 165], [-7, 0.027, 73],
  [-6, 0.020, 49], [-5, 0.583, 96], [-4, 0.023, 221], [-3, 0.021, 48],
  [-2, 0.808, 73], [-1, 0.049, 471], [0, 0.000, 122], [1, 0.875, 56],
  [2, 0.027, 257], [3, 0.007, 416], [5, 0.563, 87], [6, 0.006, 1045],
  [7, 0.077, 91], [8, 0.038, 53], [9, 0.023, 299], [10, 0.036, 196],
  [11, 0.000, 46], [12, 0.307, 88], [13, 0.006, 358], [14, 0.033, 61],
  [16, 0.013, 149], [17, 0.035, 85], [19, 0.208, 53], [20, 0.000, 127],
  [23, 0.022, 46], [24, 0.000, 42], [27, 0.044, 45],
];
const LATE_TABLE: [number, number, number][] = [
  [-11, 0.200, 15], [-8, 0.583, 24], [-7, 0.000, 16], [-6, 0.000, 18],
  [-4, 0.037, 27], [-2, 1.000, 21], [-1, 0.281, 57], [0, 0.000, 27],
  [1, 1.000, 26], [2, 0.025, 40], [3, 0.000, 45], [5, 1.000, 15],
  [6, 0.000, 25], [9, 0.059, 17], [13, 0.000, 16], [16, 0.000, 20],
];

const asTallies = (rows: [number, number, number][]) =>
  new Map(rows.map(([margin, rate, all]) =>
    [margin, { two: Math.round(rate * all), all }]));

const DEFAULT_OVERALL = asTallies(OVERALL);
const DEFAULT_LATE = asTallies(LATE_TABLE);

export const DEFAULT_AFTER_TOUCHDOWN: AfterTouchdown = {
  goesForTwo: (margin, secondsLeft) => {
    if (secondsLeft <= LATE) {
      const cell = DEFAULT_LATE.get(margin);

      if (cell && cell.all >= LEAST_LATE) {
        return cell.two / cell.all;
      }
    }

    const cell = DEFAULT_OVERALL.get(margin);
    return cell ? cell.two / cell.all : 0.095;
  },
  convertRate: 0.474,
  extraPointRate: 0.952,
};
