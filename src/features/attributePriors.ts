/**
 * What to expect of a man before he has done anything, from what he is.
 *
 * fitRoles shrinks a thin player toward the league: a catch rate of
 * .64, 10.4 yards a catch, 4.3 a carry, and the same swing for
 * everybody. Nobody is league average across the board, so every one of
 * those is an error the moment it is applied to a particular man.
 *
 * He already has thirty four attributes. Guessing his rates from those
 * gives a target to shrink toward that is his rather than the league's,
 * and it works for a man with no history at all, which is where
 * shrinking to the league hurts most.
 */

import { fitRidge, predictRidge } from "../backtest/ridge.js";
import { buildPlayerVectors, type PlayerVector } from "./playerVector.js";

export interface Expected {
  catchRate: number;
  yardsPerCatch: number;
  /** what he makes once he is hit, which is his where a whole carry is not */
  afterContact: number;
  /** how far his yards swing about their own average */
  swing: number;
}

export interface PriorSettings {
  /** how hard to keep a guess near what the position usually does */
  penalty: number;
}

export const PRIOR_DEFAULTS: PriorSettings = { penalty: 3 };

/** how far to lean on the attributes for each rate, against the league */
export type Leanings = Record<keyof Expected, number>;

/** what a man actually did, to fit the guesses against */
export interface Shown extends Expected {
  playerId: string;
  touches: number;
}

export const RATES: (keyof Expected)[] = [
  "catchRate", "yardsPerCatch", "afterContact", "swing",
];

/**
 * How far to lean on the attributes for each rate, worked out rather
 * than chosen.
 *
 * Saying attributes for these and the league for those is picking
 * whichever won on the men being scored. One rule instead: guess from
 * the attributes, pull toward the league, and fit how far by trying it
 * on a season nobody is being judged on. A guess with nothing behind it
 * takes a lean of nothing by itself.
 */
export function fitLeanings(
  guessed: Map<string, Expected>,
  wentOnToDo: Shown[],
  league: Expected,
): Leanings {
  const out = {} as Leanings;

  for (const rate of RATES) {
    const men = wentOnToDo.filter((m) => guessed.has(m.playerId));
    let best = 0;
    let bestMiss = Infinity;

    for (let lean = 0; lean <= 1.001; lean += 0.05) {
      let miss = 0;

      for (const man of men) {
        const said = lean * guessed.get(man.playerId)![rate] +
          (1 - lean) * league[rate];
        miss += (said - man[rate]) ** 2;
      }

      if (miss < bestMiss) {
        bestMiss = miss;
        best = lean;
      }
    }

    out[rate] = men.length >= 25 ? best : 0;
  }

  return out;
}

/** the two put together, at whatever lean was fitted */
export const leaning = (
  guessed: Expected | undefined, league: Expected, leanings: Leanings,
): Expected => {
  const out = {} as Expected;

  for (const rate of RATES) {
    out[rate] = guessed
      ? leanings[rate] * guessed[rate] + (1 - leanings[rate]) * league[rate]
      : league[rate];
  }

  return out;
};

const bounded = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, value));

/**
 * One guess per player. Fitted separately for each position, since what
 * a big number of yards a catch means for a back and for a receiver are
 * different things.
 */
/**
 * Fitted from one season's attributes to the next season's rates, and
 * applied to a later season's attributes.
 *
 * Fitting a season's attributes to its own rates teaches nothing: the
 * vector contains his catch rate, so a fit learns to copy it, and then
 * on a man with forty targets it copies noise. Asking a season's
 * attributes about the season after forces it to lean on the parts that
 * carry, which is what a man with no history needs.
 */
export async function expectedFrom(
  learnFrom: number,
  wentOnToDo: Shown[],
  applyTo: number,
  settings: PriorSettings = PRIOR_DEFAULTS,
): Promise<Map<string, Expected>> {
  const learnVectors = await buildPlayerVectors(learnFrom);
  const vectors = await buildPlayerVectors(applyTo);
  const byPosition = new Map<string, Shown[]>();

  for (const man of wentOnToDo) {
    const described = learnVectors.get(man.playerId);

    if (!described || man.touches < 25) {
      continue;
    }

    byPosition.set(
      described.position, [...(byPosition.get(described.position) ?? []), man],
    );
  }

  const out = new Map<string, Expected>();
  const row = (described: PlayerVector) => [1, ...described.values];

  for (const [position, men] of byPosition) {
    if (men.length < 20) {
      continue;
    }

    const rows = men.map((man) => row(learnVectors.get(man.playerId)!));
    const weightsFor = (of: (man: Shown) => number) =>
      fitRidge(rows, men.map(of), settings.penalty);
    const forCatch = weightsFor((m) => m.catchRate);
    const forCatchYards = weightsFor((m) => m.yardsPerCatch);
    const forAfterContact = weightsFor((m) => m.afterContact);
    const forSwing = weightsFor((m) => m.swing);
    const average = {
      catchRate: men.reduce((a, m) => a + m.catchRate, 0) / men.length,
      yardsPerCatch: men.reduce((a, m) => a + m.yardsPerCatch, 0) / men.length,
      afterContact: men.reduce((a, m) => a + m.afterContact, 0) / men.length,
      swing: men.reduce((a, m) => a + m.swing, 0) / men.length,
    };

    for (const [playerId, described] of vectors) {
      if (described.position !== position) {
        continue;
      }

      const at = row(described);
      out.set(playerId, {
        // held near what the position does, since a ridge on thirty four
        // numbers will say something silly about somebody
        catchRate: bounded(predictRidge(forCatch, at), 0.35, 0.85),
        yardsPerCatch: bounded(
          predictRidge(forCatchYards, at), average.yardsPerCatch * 0.55,
          average.yardsPerCatch * 1.8,
        ),
        afterContact: bounded(
          predictRidge(forAfterContact, at), average.afterContact * 0.55,
          average.afterContact * 1.8,
        ),
        swing: bounded(predictRidge(forSwing, at), 0.15, 0.9),
      });
    }
  }

  return out;
}
