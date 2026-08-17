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
  yardsPerCarry: number;
  /** how far his yards swing about their own average */
  swing: number;
}

export interface PriorSettings {
  /** how hard to hold a guess to what the position usually does */
  penalty: number;
}

export const PRIOR_DEFAULTS: PriorSettings = { penalty: 3 };

/** what a man actually did, to fit the guesses against */
export interface Shown extends Expected {
  playerId: string;
  touches: number;
}

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
    const forCarryYards = weightsFor((m) => m.yardsPerCarry);
    const forSwing = weightsFor((m) => m.swing);
    const average = {
      catchRate: men.reduce((a, m) => a + m.catchRate, 0) / men.length,
      yardsPerCatch: men.reduce((a, m) => a + m.yardsPerCatch, 0) / men.length,
      yardsPerCarry: men.reduce((a, m) => a + m.yardsPerCarry, 0) / men.length,
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
        yardsPerCarry: bounded(
          predictRidge(forCarryYards, at), average.yardsPerCarry * 0.6,
          average.yardsPerCarry * 1.6,
        ),
        swing: bounded(predictRidge(forSwing, at), 0.15, 0.9),
      });
    }
  }

  return out;
}
