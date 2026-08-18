/**
 * A drive as the play factors applied in sequence.
 *
 * Nothing about a drive is fitted here. How long they run, how often
 * they score, how often they stall: all of it comes out of the factors
 * and the chains, so a drive that comes out wrong points at a factor
 * rather than at a rule about drives.
 *
 * The fourth down choice, the kick and the punt are not play factors.
 * They decide whether a play happens at all, so they come in from
 * outside.
 */

import type { Call, PlayFactors, PlayState } from "./playFactors.js";
import type { DriveEnd } from "./drive.js";
import type { PlayClock } from "../features/fitPlayClock.js";
import type { FourthDown } from "../features/fitFourthDown.js";

export interface EndingRules {
  kickSucceeds: (yardline: number) => number;
  puntLands: (yardline: number, uniform: () => number) => number;
  turnoverRate: (call: Call) => number;
  /** and the same off the state, where it is known */
  turnoverAt?: (state: PlayState, call: Call) => number;
  /**
   * A defensive penalty that hands over a first down. It happens on 16%
   * of drives and is the one way a drive carries on without the offence
   * doing anything. The older walks have it and this one was written
   * without it, which is most of why it does not finish.
   */
  penaltyFirstDown: number;
  penaltyYards: (uniform: () => number) => number;
  maxPlays: number;
}

/**
 * Which drive the half runs out on.
 *
 * Nearly seven percent of drives end that way. Taking a slice off every
 * drive instead cuts short the ones that were about to score, which
 * cost two points of touchdown rate. A half ends on one drive, so one
 * drive in fourteen gets a short budget of plays and the rest get none
 * of this at all.
 */
export interface ClockRules {
  /** how often a drive is the last of a half */
  isLast: number;
  /** how many snaps one of those gets, drawn */
  lastLength: (uniform: () => number) => number;
}

export const CLOCK_DEFAULTS: ClockRules = {
  isLast: 0.071,
  lastLength: (uniform) => 1 + Math.floor(uniform() * 12),
};

export interface FactorPlay {
  state: PlayState;
  call: Call;
  player: string;
  yards: number;
  scored: boolean;
}

export interface FactorDrive {
  plays: FactorPlay[];
  ending: DriveEnd;
  /** where the other side takes over, counted from their own goal */
  handsOverAt: number;
  /** and how much of the clock went by, when one is being kept */
  took: number;
}

/** where a game stands when a drive begins */
export interface Opening {
  yardline: number;
  /** this side's lead, since it moves what gets called */
  margin: number;
  secondsLeft: number;
}

export function walkDrive(
  startAt: number,
  factors: PlayFactors,
  rules: EndingRules,
  fourth: FourthDown,
  among: string[],
  uniform: () => number,
  clock: ClockRules = CLOCK_DEFAULTS,
  /** who is playing, so the two sides can bend what a play does */
  sides: {
    offence?: string; defence?: string;
    passer?: string; season?: number; week?: number;
  } = {},
  /**
   * How long each snap takes. Without one the drive has no length in
   * time, so a game has to be told how many drives it gets instead of
   * playing until the clock runs out.
   */
  ticking?: PlayClock,
  /**
   * Where the game stands. The factors already ask about the score and
   * the clock, and the walk used to answer nil and half time on every
   * drive, so nothing it fitted about either could ever apply.
   */
  opening: Opening = { yardline: startAt, margin: 0, secondsLeft: 1800 },
): FactorDrive {
  const plays: FactorPlay[] = [];
  const state: PlayState = {
    down: 1, toGo: 10, yardline: opening.yardline,
    margin: opening.margin, secondsLeft: opening.secondsLeft,
  };
  let took = 0;
  const tick = (call: Call, yards: number) => {
    const seconds = ticking
      ? ticking.secondsFor(call, yards, state.margin, state.secondsLeft)
      : 0;
    took += seconds;
    state.secondsLeft = Math.max(0, state.secondsLeft - seconds);
  };
  const ended = (ending: DriveEnd, handsOverAt: number): FactorDrive =>
    ({ plays, ending, handsOverAt, took });
  // how many snaps there is time for, when this is the last drive of a
  // half. Drawn once, so a drive either has a clock on it or does not.
  const budget = uniform() < clock.isLast
    ? clock.lastLength(uniform)
    : Infinity;

  for (;;) {
    if (plays.length >= Math.min(rules.maxPlays, budget)) {
      return ended("clock", 75);
    }

    if (state.down === 4) {
      const choice = fourth.choose(state, uniform);

      if (choice === "kick") {
        // a made kick is followed by a kickoff, a missed one hands the
        // ball over where it was taken from
        return uniform() < rules.kickSucceeds(state.yardline)
          ? ended("fieldGoal", 75)
          : ended("missedKick", 100 - Math.min(92, state.yardline + 8));
      }

      if (choice === "punt") {
        return ended("punt", rules.puntLands
          ? rules.puntLands(state.yardline, uniform)
          : Math.max(20, Math.min(95, 100 - state.yardline + 40)));
      }
    }

    if (uniform() < rules.penaltyFirstDown) {
      state.yardline = Math.max(1, state.yardline - rules.penaltyYards(uniform));
      state.down = 1;
      state.toGo = Math.min(10, state.yardline);
      plays.push({
        state: { ...state }, call: "pass", player: "", yards: 0, scored: false,
      });
      tick("pass", 0);
      continue;
    }

    const call: Call = uniform() < factors.runs(state, sides.offence)
      ? "run" : "pass";

    const givenAway = rules.turnoverAt
      ? rules.turnoverAt(state, call)
      : rules.turnoverRate(call);

    if (uniform() < givenAway) {
      return ended("turnover", 100 - state.yardline);
    }

    // who it goes to, from the men on the field at this state
    const shares = factors.goesTo(state, call, among);
    let left = uniform();
    let player = among[among.length - 1] ?? "";

    for (const [who, share] of shares) {
      left -= share;

      if (left <= 0) {
        player = who;
        break;
      }
    }

    const gained = Math.min(
      state.yardline,
      Math.round(factors.gains(state, call, player, uniform, sides)),
    );
    const scored = state.yardline - gained <= 0;
    plays.push({ state: { ...state }, call, player, yards: gained, scored });
    tick(call, gained);
    state.yardline -= gained;

    if (state.yardline <= 0) {
      return ended("touchdown", 75);
    }

    if (gained >= state.toGo) {
      state.down = 1;
      state.toGo = Math.min(10, state.yardline);
      continue;
    }

    state.toGo -= gained;
    state.down++;

    if (state.down > 4) {
      return ended("downs", 100 - state.yardline);
    }
  }
}
