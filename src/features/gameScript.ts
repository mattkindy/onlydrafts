/**
 * What a fixture does to how often a side runs and throws.
 *
 * A back's share of his side's carries barely moves week to week. How
 * many carries there are to take does, because chasing a good side
 * means throwing and leading a poor one means running the clock down.
 * The weekly model works on a man's points, so it has nowhere to put
 * that. The walk tracks the score and picks its calls off it, so this
 * takes the effect out of the walk and hands it to the weekly view.
 *
 * Read straight, the walk's weeks are mostly sampling until it has run
 * hundreds of times. These are pooled over every fixture a side played,
 * which settles far sooner. See scripts/aggregateGameScript.ts.
 */

export interface Script {
  /** what to multiply a side's carries by, against this defence */
  carries: (defence: string) => number;
  /** and its targets, which move the other way */
  targets: (defence: string) => number;
}

export interface Effect {
  defence: string;
  /** carries against a level opponent, so under one means fewer */
  carries: number;
  targets: number;
}

/**
 * Pulled most of the way back toward level.
 *
 * The walk is one model's opinion about a defence rather than a
 * measurement of one, and the fit that produced these explains 0.026
 * of a side's carries. Taking it at face value would say more than the
 * evidence does.
 */
const KEEP = 0.5;

/** nothing here should move a side's week by more than this either way */
const MOST = 0.12;

const held = (lift: number) =>
  Math.max(1 - MOST, Math.min(1 + MOST, 1 + KEEP * (lift - 1)));

export function scriptFrom(effects: Effect[]): Script {
  const carriesAt = new Map(effects.map((e) => [e.defence, held(e.carries)]));
  const targetsAt = new Map(effects.map((e) => [e.defence, held(e.targets)]));

  return {
    carries: (defence) => carriesAt.get(defence) ?? 1,
    targets: (defence) => targetsAt.get(defence) ?? 1,
  };
}

/**
 * What a fixture is worth to one man, given how much of his work is
 * running and how much is catching.
 *
 * A back who never catches it takes the whole of the carries effect. A
 * receiver takes the targets one. Most men are somewhere between and
 * the two pull against each other, which is why this is a blend rather
 * than a pick.
 */
export function liftFor(
  script: Script,
  defence: string,
  runShare: number,
): number {
  const share = Math.max(0, Math.min(1, runShare));

  return share * script.carries(defence) + (1 - share) * script.targets(defence);
}
