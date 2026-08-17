/**
 * What the defence does to a play, as a multiplier on the yards.
 *
 * Pooling a defence's plays in with the offence's made things slightly
 * worse, because a bigger bucket to draw from is not a matchup. This
 * asks the network the question directly: with these eleven out there
 * against an average offence, how do the yards compare with an average
 * eleven in the same spot.
 */

import { predict, type Described, type InteractionNet } from "../model/interactionNet.js";

export interface Against {
  run: number;
  pass: number;
}

export const NOBODY: Against = { run: 1, pass: 1 };

export interface AgainstSettings {
  /**
   * How far a defence may move the yards. The network is fitted on
   * pooled descriptions and its level is not to be trusted far, so this
   * keeps one from running away with a drive.
   */
  most: number;
}

export const AGAINST_DEFAULTS: AgainstSettings = { most: 0.2 };

/** the state a play is run from, as the network was fed it */
export type SituationRow = (run: boolean) => Float64Array;

/**
 * One multiplier per kind of play.
 *
 * The offence is held at the league average on both sides of the
 * comparison, so what comes out is the defence on its own rather than
 * the pairing, which is what a multiplier can carry.
 */
export function againstDefence(
  net: InteractionNet,
  defence: Float64Array,
  averageOffence: Float64Array,
  averageDefence: Float64Array,
  situation: SituationRow,
  settings: AgainstSettings = AGAINST_DEFAULTS,
): Against {
  const ask = (theirs: Float64Array, run: boolean) => {
    const on: Described[] = [
      { kind: "offence", values: averageOffence },
      { kind: "defence", values: theirs },
      { kind: "situation", values: situation(run) },
    ];
    return predict(net, on, "yards");
  };

  const ratio = (run: boolean) => {
    const plain = ask(averageDefence, run);

    if (!Number.isFinite(plain) || Math.abs(plain) < 0.5) {
      return 1;
    }

    const theirs = ask(defence, run);
    const raw = theirs / plain;

    if (!Number.isFinite(raw)) {
      return 1;
    }

    return Math.max(1 - settings.most, Math.min(1 + settings.most, raw));
  };

  return { run: ratio(true), pass: ratio(false) };
}
