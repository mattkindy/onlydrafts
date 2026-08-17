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
import { KICK_LENGTH } from "./drive.js";

export interface EndingRules {
  goesForIt: (yardline: number, toGo: number, uniform: () => number) => boolean;
  kickSucceeds: (yardline: number) => number;
  puntLands: (yardline: number, uniform: () => number) => number;
  turnoverRate: (call: Call) => number;
  maxPlays: number;
}

/**
 * How often a snap is the last one because the half or the game runs
 * out. Nearly seven percent of drives end that way and a walk that
 * never stops for the clock has to end those some other way, which is
 * most of why it punts too much.
 */
export interface ClockRules {
  /** the chance a drive is cut off after any given play */
  runsOut: number;
}

export const CLOCK_DEFAULTS: ClockRules = { runsOut: 0.012 };

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
}

export function walkDrive(
  startAt: number,
  factors: PlayFactors,
  rules: EndingRules,
  among: string[],
  uniform: () => number,
  clock: ClockRules = CLOCK_DEFAULTS,
): FactorDrive {
  const plays: FactorPlay[] = [];
  const state: PlayState = {
    down: 1, toGo: 10, yardline: startAt, margin: 0, secondsLeft: 1800,
  };

  for (;;) {
    if (plays.length >= rules.maxPlays) {
      return { plays, ending: "clock" };
    }

    if (state.down === 4 && !rules.goesForIt(state.yardline, state.toGo, uniform)) {
      if (KICK_LENGTH(state.yardline) <= 62 && state.yardline <= 40) {
        return uniform() < rules.kickSucceeds(state.yardline)
          ? { plays, ending: "fieldGoal" }
          : { plays, ending: "missedKick" };
      }

      return { plays, ending: "punt" };
    }

    const call: Call = uniform() < factors.runs(state) ? "run" : "pass";

    if (uniform() < rules.turnoverRate(call)) {
      return { plays, ending: "turnover" };
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
      state.yardline, Math.round(factors.gains(state, call, player, uniform)),
    );
    const scored = state.yardline - gained <= 0;
    plays.push({ state: { ...state }, call, player, yards: gained, scored });
    state.yardline -= gained;

    if (state.yardline <= 0) {
      return { plays, ending: "touchdown" };
    }

    if (uniform() < clock.runsOut) {
      return { plays, ending: "clock" };
    }

    if (gained >= state.toGo) {
      state.down = 1;
      state.toGo = Math.min(10, state.yardline);
      continue;
    }

    state.toGo -= gained;
    state.down++;

    if (state.down > 4) {
      return { plays, ending: "downs" };
    }
  }
}
