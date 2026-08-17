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
 * The states near this one, nearest first.
 *
 * The clock and the score are let go before the field is, since they
 * move a call less than the down and the distance do. A thin state ends
 * up borrowing from any time and any score at the same spot before it
 * borrows from a different spot.
 */
export function* widening(
  state: PlayState,
): Generator<{ toGo: number; yardline: number; loose: boolean }> {
  // The clock and the score are held first and let go only when this
  // spot cannot answer for itself. Offering the any-time cell up front
  // meant it always had enough plays, and the call never moved with the
  // game at all.
  for (const reach of [0, 1, 2, 3, 5]) {
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
          yield { toGo, yardline: yard, loose: false };
        }
      }
    }
  }

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

        // only the ring just added, so a caller can stop as soon as it
        // has seen enough without walking the same states again
        const onEdge = Math.abs(yard - state.yardline) === reach ||
          Math.abs(toGo - state.toGo) === near;

        if (reach === 0 || onEdge) {
          yield { toGo, yardline: yard, loose: true };
        }
      }
    }
  }
}

/**
 * How the clock and the score are cut for counting.
 *
 * A team two scores down with four minutes left calls a different game
 * from the same team level in the first quarter, and neither the down
 * nor the field position says so. Coarse on purpose: these matter far
 * less than the down and the distance, and a fine cut on four things at
 * once leaves nothing in any cell.
 */
export const timeBand = (secondsLeft: number) =>
  secondsLeft > 1500 ? 0
    : secondsLeft > 300 ? 1
    : secondsLeft > 120 ? 2
    : 3;

export const marginBand = (margin: number) =>
  margin <= -9 ? 0 : margin < 0 ? 1 : margin < 9 ? 2 : 3;

export const stateKey = (
  down: number, toGo: number, yardline: number,
  secondsLeft = 1800, margin = 0,
) =>
  `${Math.min(4, down)}|${Math.min(40, toGo)}|${Math.min(99, yardline)}` +
  `|${timeBand(secondsLeft)}|${marginBand(margin)}`;
