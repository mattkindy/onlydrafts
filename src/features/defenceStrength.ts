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
 * Both sides at once, each measured against an average one.
 *
 * Asking only what a defence does leaves the offence at the league, so
 * a good side meeting a good side comes out average when it should come
 * out somewhere in between. The two are asked separately and their
 * effects multiplied, which is what the network was fitted to do.
 */
export function matchup(
  net: InteractionNet,
  offence: Float64Array,
  defence: Float64Array,
  averageOffence: Float64Array,
  averageDefence: Float64Array,
  situation: SituationRow,
  settings: AgainstSettings = AGAINST_DEFAULTS,
): Against {
  const ask = (them: Float64Array, they: Float64Array, run: boolean) =>
    predict(net, [
      { kind: "offence", values: them },
      { kind: "defence", values: they },
      { kind: "situation", values: situation(run) },
    ], "yards");

  const ratio = (run: boolean) => {
    const plain = ask(averageOffence, averageDefence, run);

    if (!Number.isFinite(plain) || Math.abs(plain) < 0.5) {
      return 1;
    }

    const theirs = ask(offence, defence, run);
    const raw = theirs / plain;

    if (!Number.isFinite(raw)) {
      return 1;
    }

    return Math.max(1 - settings.most, Math.min(1 + settings.most, raw));
  };

  return { run: ratio(true), pass: ratio(false) };
}

/**
 * A defence on its own, with the offence held at the league on both
 * sides of the comparison. Superseded by the pairing above and kept
 * because one eval still scores against it.
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
