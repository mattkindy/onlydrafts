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
  /** how often the call is a run, for this offence where it is known */
  runs: (state: PlayState, offence?: string) => number;
  /** how the work at this state divides between the men available */
  goesTo: (state: PlayState, call: Call, among: string[]) => Map<string, number>;
  /** what he gains, drawn */
  gains: (
    state: PlayState, call: Call, player: string, uniform: () => number,
    sides?: {
      offence?: string; defence?: string;
      /** who threw it, and when, so a level model can be asked */
      passer?: string; season?: number; week?: number;
    },
  ) => number;
  /** how often it ends in the end zone from here, given the yards */
  scores: (state: PlayState, call: Call, gained: number) => number;
  /**
   * Whether a draw that crossed the goal line really scores. Draws
   * near the goal are transplanted from spots with more room and then
   * capped, so they cross more often than plays from this state score;
   * this rolls the surplus back to the one.
   */
  crossedStands?: (
    state: PlayState, call: Call, uniform: () => number,
  ) => boolean;
  /** whether a throw for this many yards was caught, drawn */
  caught: (gained: number, uniform: () => number) => boolean;
  /**
   * A whole play drawn as the man's own, yards and catch together,
   * or nothing when he is too thin to sample and the pooled path
   * should answer instead.
   */
  hisOwnPlay?: (
    state: PlayState, call: Call, player: string, uniform: () => number,
    passer?: string,
    /** and who else is out there, so a level model can be asked */
    sides?: {
      offence?: string; defence?: string;
      passer?: string; season?: number; week?: number;
    },
  ) => { yards: number; caught: boolean } | undefined;
  /**
   * What this matchup does to a carry or a throw, near one. The
   * sampled path draws a man's own plays against every defence he
   * ever faced, so without this the walk cannot tell this week's
   * opponent from an average one.
   */
  matchup?: (offence: string, defence: string, call: Call) => number;
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

      /**
       * The field opens up far faster than the distance does.
       *
       * How often a side runs turns on the distance and hardly on where
       * it is: 72% on third and one and 19% on third and eight, against
       * next to nothing between the seventy five and the forty. Letting
       * the two out together reached third and four to fill a thin
       * third and one, and said 46% where sides run 72%.
       */
      const near = reach < 12 ? 0 : reach < 35 ? 1 : 2;

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
 * The same spots as packed numbers, built once per distance and yard.
 * The generator made hundreds of objects for every query and the walk
 * queries millions of times, so the hot loops read these instead:
 * looseness times 100000, plus toGo times 100, plus the yardline.
 */
const spotsRemembered = new Map<number, Int32Array>();

export function wideningPacked(toGo: number, yardline: number): Int32Array {
  const key = toGo * 100 + yardline;
  const already = spotsRemembered.get(key);

  if (already) {
    return already;
  }

  const state = { down: 1, toGo, yardline, secondsLeft: 1800, margin: 0 };
  const packed: number[] = [];

  for (const spot of widening(state)) {
    packed.push(spot.looseness * 100000 + spot.toGo * 100 + spot.yardline);
  }

  const made = Int32Array.from(packed);
  spotsRemembered.set(key, made);

  return made;
}

/**
 * How the clock is cut for counting. Coarse on purpose: it matters far
 * less than the down and the distance, and a fine cut on everything at
 * once leaves nothing in any cell.
 */
/**
 * The cut at the fourth quarter matters most: a side up two scores
 * plays on in the second and third and shuts it down in the fourth,
 * and one band across all three mixed the two, which is why the walk's
 * leaders kept scoring at 25% a drive where played ones manage 20%.
 */
export const timeBand = (secondsLeft: number) =>
  secondsLeft > 1500 ? 0
    : secondsLeft > 900 ? 1
    : secondsLeft > 300 ? 2
    : secondsLeft > 120 ? 3
    : 4;

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

/**
 * The same state with the score let go by however much. Built once per
 * banded state and remembered, because the walk asks for these lists
 * millions of times and the strings were a third of a game's cost.
 */
const keysRemembered = new Map<number, string[]>();

export const keysAt = (
  down: number, toGo: number, yardline: number,
  secondsLeft: number, margin: number, looseness: number,
): string[] => {
  const at = (Math.min(4, down) * 41 + Math.min(40, toGo)) * 100 +
    Math.min(99, yardline);
  const packed = ((at * 8 + timeBand(secondsLeft)) * 9 + marginBand(margin)) *
    4 + looseness;
  const already = keysRemembered.get(packed);

  if (already) {
    return already;
  }

  const spot = `${Math.min(4, down)}|${Math.min(40, toGo)}|${Math.min(99, yardline)}`;
  const made = (() => {
    if (looseness >= 2) {
      return [`${spot}|any`];
    }

    const band = marginBand(margin);
    const bands = looseness === 0 ? [band] : [band - 1, band, band + 1];

    return bands.filter((b) => b >= 0 && b <= 8)
      .map((b) => `${spot}|${timeBand(secondsLeft)}|${b}`);
  })();
  keysRemembered.set(packed, made);

  return made;
};
