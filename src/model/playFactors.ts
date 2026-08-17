/**
 * A play, written as the things that decide it, each conditioned on the
 * same state.
 *
 * A snap is a call, a man it goes to, and what he gains. Those are
 * separate questions and the model has been answering each at its own
 * granularity: personnel off the continuous state, the call off four
 * distance bands, the man off four situations, the yards off the state
 * again. Composing factors fitted at different resolutions loses
 * whatever the coarsest one threw away, so they are defined together
 * here and fitted the same way.
 *
 * Everything above a play, a drive, a game, a season, is these applied
 * in sequence. Nothing above is fitted directly.
 */

/** where a play is being run from */
export interface PlayState {
  down: number;
  toGo: number;
  /** yards from the opponent's goal line */
  yardline: number;
  /** this team's lead, negative when behind */
  margin: number;
  secondsLeft: number;
}

export type Call = "run" | "pass";

export interface PlayFactors {
  /** how often the call is a run */
  runs: (state: PlayState) => number;
  /** how the work at this state divides between the men available */
  goesTo: (state: PlayState, call: Call, among: string[]) => Map<string, number>;
  /** what he gains, drawn */
  gains: (
    state: PlayState, call: Call, player: string, uniform: () => number,
  ) => number;
  /** how often it ends in the end zone from here, given the yards */
  scores: (state: PlayState, call: Call, gained: number) => number;
}

/**
 * A count kept against the exact state, so nothing is bucketed at the
 * point of fitting. Widening happens when a question is asked, not when
 * the data is stored.
 */
export interface StateCell {
  plays: number;
  runs: number;
  yards: number[];
  scores: number;
}

export const emptyCell = (): StateCell =>
  ({ plays: 0, runs: 0, yards: [], scores: 0 });

/**
 * The states near this one, nearest first, in three passes.
 *
 * Cutting the score where the football changes leaves too few plays in
 * any one cell, and jumping straight from that to any score at all
 * threw the game situation away entirely. So the score is loosened by a
 * band at a time before it is let go, the same way the field is.
 */
export interface Spot {
  toGo: number;
  yardline: number;
  /** how far the score has been let go: 0 exact, 1 either side, 2 any */
  looseness: number;
}

function* ring(state: PlayState, looseness: number): Generator<Spot> {
  for (const reach of [0, 1, 2, 3, 5, 8, 12, 20, 35, 60, 99]) {
    for (let yard = state.yardline - reach; yard <= state.yardline + reach; yard++) {
      if (yard < 1 || yard > 99) {
        continue;
      }

      const near = Math.ceil(reach / 2);

      for (let toGo = state.toGo - near; toGo <= state.toGo + near; toGo++) {
        if (toGo < 1 || toGo > 40) {
          continue;
        }

        const onEdge = Math.abs(yard - state.yardline) === reach ||
          Math.abs(toGo - state.toGo) === near;

        if (reach === 0 || onEdge) {
          yield { toGo, yardline: yard, looseness };
        }
      }
    }
  }
}

export function* widening(state: PlayState): Generator<Spot> {
  yield* ring(state, 0);
  yield* ring(state, 1);
  yield* ring(state, 2);
}

/**
 * How the clock is cut for counting. Coarse on purpose: it matters far
 * less than the down and the distance, and a fine cut on everything at
 * once leaves nothing in any cell.
 */
export const timeBand = (secondsLeft: number) =>
  secondsLeft > 1500 ? 0
    : secondsLeft > 300 ? 1
    : secondsLeft > 120 ? 2
    : 3;

/**
 * The score, cut where the football changes rather than at round
 * numbers. Three points is a kick and eight is a touchdown with the
 * two, so a side three down and one eight down are playing different
 * games. Sixteen is two scores either way.
 */
export const marginBand = (margin: number) =>
  margin <= -16 ? 0
    : margin <= -9 ? 1
    : margin <= -4 ? 2
    : margin < 0 ? 3
    : margin === 0 ? 4
    : margin <= 3 ? 5
    : margin <= 8 ? 6
    : margin <= 15 ? 7
    : 8;

export const stateKey = (
  down: number, toGo: number, yardline: number,
  secondsLeft = 1800, margin = 0,
) =>
  `${Math.min(4, down)}|${Math.min(40, toGo)}|${Math.min(99, yardline)}` +
  `|${timeBand(secondsLeft)}|${marginBand(margin)}`;

/** the same state with the score let go by however much */
export const keysAt = (
  down: number, toGo: number, yardline: number,
  secondsLeft: number, margin: number, looseness: number,
): string[] => {
  const spot = `${Math.min(4, down)}|${Math.min(40, toGo)}|${Math.min(99, yardline)}`;

  if (looseness >= 2) {
    return [`${spot}|any`];
  }

  const band = marginBand(margin);
  const bands = looseness === 0 ? [band] : [band - 1, band, band + 1];

  return bands.filter((b) => b >= 0 && b <= 8)
    .map((b) => `${spot}|${timeBand(secondsLeft)}|${b}`);
};
