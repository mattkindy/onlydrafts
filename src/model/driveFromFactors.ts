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
}

export const CLOCK_DEFAULTS: ClockRules = { isLast: 0.071 };

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
  // how many snaps there is time for, when this is the last drive of a
  // half. Drawn once, so a drive either has a clock on it or does not.
  const budget = uniform() < clock.isLast
    ? 1 + Math.floor(uniform() * 12)
    : Infinity;

  for (;;) {
    if (plays.length >= Math.min(rules.maxPlays, budget)) {
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
