/**
 * A drive, played out one snap at a time.
 *
 * The old simulation handed a team a fixed number of snaps in each of
 * four named situations and split them up. This starts at a yard line
 * on first and ten and walks: pick a run or a pass, gain what such a
 * play gains, move the chains or do not, and stop at a score, a
 * turnover, or a fourth down it decides not to take.
 *
 * Every situation then turns up as often as the game produces it, and
 * a team's players are tied together the way they really are, since a
 * twelve play drive gives everybody a touch and a three and out gives
 * nobody one.
 */

export interface DriveState {
  down: number;
  toGo: number;
  /** yards from the opponent's goal line */
  yardline: number;
  plays: number;
}

export type PlayType = "run" | "pass";

export type DriveEnd =
  | "touchdown" | "fieldGoal" | "missedKick"
  | "punt" | "downs" | "turnover" | "clock";

export interface DrivePlay {
  state: DriveState;
  type: PlayType;
  yards: number;
}

export interface Drive {
  plays: DrivePlay[];
  ending: DriveEnd;
  /** where the other team takes over, from their own goal line */
  handsOverAt: number;
}

export interface DriveRules {
  /** how often it is a run, by down and by yards to go */
  runRate: (down: number, toGo: number) => number;
  /**
   * One play's yards, drawn from what such a play gains. Field position
   * belongs here: a carry from the two gains 0.7 yards on average and
   * one from midfield gains 4.5, and drawing both from one pool is why
   * the walk had to clamp its own answers.
   */
  yardsFor: (
    type: PlayType, down: number, toGo: number, yardline: number,
    uniform: () => number,
  ) => number;
  /** how often a play is given away */
  turnoverRate: (type: PlayType) => number;
  /** whether to go for it rather than punt or kick */
  goesForIt: (yardline: number, toGo: number, uniform: () => number) => boolean;
  /** how often a kick from here is good */
  kickSucceeds: (yardline: number) => number;
  /** how far a punt from here leaves them */
  puntLands: (yardline: number, uniform: () => number) => number;
  /** how often a snap is wiped out by a penalty that moves the chains */
  penaltyFirstDown: number;
  /** what such a penalty is worth */
  penaltyYards: (uniform: () => number) => number;
  /** how often a false start or a hold replays the down from further back */
  offenceFlag?: number;
  offenceFlagYards?: (uniform: () => number) => number;
  /** how often a defensive offside moves the ball five yards short of the chains */
  defenceFlag?: number;
  /** the most snaps a drive gets before the clock is called on it */
  maxPlays: number;
}

/**
 * A kick is from the yard line plus the seven yards of snap and hold
 * plus the ten of end zone, and gets harder the further out it is.
 */
export const KICK_LENGTH = (yardline: number) => yardline + 17;

/**
 * How well the drive is going, drawn once and applied to every snap in
 * it. Sampling each play on its own produced 32% three and outs where
 * the real number is 25%, because independent short gains stack up far
 * more often than they do when an offence has found something.
 */
export interface DriveForm {
  /** multiplies each gain; one is an ordinary drive */
  going: number;
}

export function simulateDrive(
  startAt: number,
  rules: DriveRules,
  uniform: () => number,
  form: DriveForm = { going: 1 },
): Drive {
  const plays: DrivePlay[] = [];
  const state: DriveState = { down: 1, toGo: 10, yardline: startAt, plays: 0 };

  for (;;) {
    if (state.plays >= rules.maxPlays) {
      return { plays, ending: "clock", handsOverAt: 75 };
    }

    if (state.down === 4) {
      const kickable = KICK_LENGTH(state.yardline) <= 62;

      if (!rules.goesForIt(state.yardline, state.toGo, uniform)) {
        if (kickable && state.yardline <= 40) {
          return uniform() < rules.kickSucceeds(state.yardline)
            ? { plays, ending: "fieldGoal", handsOverAt: 75 }
            : { plays, ending: "missedKick", handsOverAt: 100 - state.yardline };
        }

        return {
          plays, ending: "punt",
          handsOverAt: rules.puntLands(state.yardline, uniform),
        };
      }
    }

    // the defence is flagged and the offence gets a new set of downs
    // without running a play anybody can be credited for
    if (uniform() < rules.penaltyFirstDown) {
      const given = rules.penaltyYards(uniform);
      // a penalty in the field of play cannot score, so the worst it
      // does is put them on the one
      state.yardline = Math.max(1, state.yardline - given);
      state.down = 1;
      state.toGo = Math.min(10, state.yardline);
      state.plays++;
      continue;
    }

    const type: PlayType =
      uniform() < rules.runRate(state.down, state.toGo) ? "run" : "pass";

    if (uniform() < rules.turnoverRate(type)) {
      return { plays, ending: "turnover", handsOverAt: 100 - state.yardline };
    }

    const drawn = rules.yardsFor(
      type, state.down, state.toGo, state.yardline, uniform,
    );
    const yards = Math.min(
      state.yardline,
      // a loss is a loss whatever the drive is doing
      drawn <= 0 ? drawn : Math.round(drawn * form.going),
    );
    plays.push({ state: { ...state }, type, yards });
    state.plays++;
    state.yardline -= yards;

    if (state.yardline <= 0) {
      return { plays, ending: "touchdown", handsOverAt: 75 };
    }

    if (yards >= state.toGo) {
      state.down = 1;
      state.toGo = Math.min(10, state.yardline);
      continue;
    }

    state.toGo -= yards;
    state.down++;

    if (state.down > 4) {
      return { plays, ending: "downs", handsOverAt: 100 - state.yardline };
    }
  }
}
