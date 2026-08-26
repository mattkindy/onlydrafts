/**
 * One model over everything a season said about a man.
 *
 * The parts of his play are not independent. A staff throws at him more
 * because he is better with it, so how often he got it and what he did
 * with it each say something about the other's future that the other's
 * own past does not. Pulling each part back toward the league on its
 * own treats them as separate and gives that up.
 *
 * So this hands the lot to one fit. Measured in
 * scripts/jointProjectionEval.ts, where it takes a quarter to a third
 * off the error against pulling them back one at a time.
 */

import { fitRidge, predictRidge } from "../backtest/ridge.js";

/** everything one season recorded about him, before any of it is judged */
export interface Parts {
  games: number;
  targets: number;
  receptions: number;
  /** over his catches, not his targets */
  beforeCatch: number;
  afterCatch: number;
  drops: number;
  carries: number;
  beforeContact: number;
  afterContact: number;
  age: number;
  /**
   * What a passer did. The air yards split, which is the throwing
   * equivalent of how far a run went before contact, only starts in
   * 2024, so these are the ones with a history behind them: how often
   * he throws, how often it is on target, how often he is under
   * pressure, and how often he throws it away.
   */
  passAttempts: number;
  onTarget: number;
  badThrows: number;
  throwaways: number;
  pressured: number;
}

export const noParts = (): Parts => ({
  games: 0, targets: 0, receptions: 0, beforeCatch: 0, afterCatch: 0,
  drops: 0, carries: 0, beforeContact: 0, afterContact: 0, age: 0,
  passAttempts: 0, onTarget: 0, badThrows: 0, throwaways: 0, pressured: 0,
});

const per = (top: number, bottom: number) => (bottom > 0 ? top / bottom : 0);

/**
 * His season as rates, since a man who played nine games and one who
 * played seventeen are being asked the same question.
 */
export function columnsFor(parts: Parts): number[] {
  const games = Math.max(1, parts.games);

  return [
    1,
    per(parts.targets, games),
    per(parts.receptions, games),
    per(parts.beforeCatch + parts.afterCatch, games),
    per(parts.receptions, parts.targets),
    per(parts.beforeCatch, parts.receptions),
    per(parts.afterCatch, parts.receptions),
    per(parts.drops, parts.targets),
    per(parts.carries, games),
    per(parts.beforeContact + parts.afterContact, games),
    per(parts.beforeContact, parts.carries),
    per(parts.afterContact, parts.carries),
    parts.age / 30,
    Math.min(17, parts.games) / 17,
    per(parts.passAttempts, games),
    parts.onTarget / 100,
    parts.badThrows / 100,
    per(parts.throwaways, parts.passAttempts),
    parts.pressured / 100,
  ];
}

export interface Fitted {
  /** what it says he scores a game next season */
  says: (parts: Parts, position: string) => number;
  /** how many men stood behind each position's fit */
  learnedFrom: Map<string, number>;
}

/** a position with fewer than this many men falls back to everybody */
const ENOUGH = 60;

/**
 * One fit per position, since a back's carries and a receiver's targets
 * do not mean the same thing, with everybody's fit standing in where a
 * position is too thin to speak for itself.
 */
export function fitJoint(
  learn: { parts: Parts; position: string; scored: number }[],
  penalty = 0.5,
): Fitted {
  const byPosition = new Map<string, typeof learn>();

  for (const one of learn) {
    byPosition.set(one.position, [...(byPosition.get(one.position) ?? []), one]);
  }

  const fitOver = (its: typeof learn) =>
    fitRidge(its.map((o) => columnsFor(o.parts)), its.map((o) => o.scored), penalty);

  const everyone = fitOver(learn);
  const weights = new Map<string, number[]>();
  const learnedFrom = new Map<string, number>();

  for (const [position, its] of byPosition) {
    learnedFrom.set(position, its.length);
    weights.set(position, its.length >= ENOUGH ? fitOver(its) : everyone);
  }

  return {
    learnedFrom,
    says: (parts, position) => Math.max(
      0, predictRidge(weights.get(position) ?? everyone, columnsFor(parts)),
    ),
  };
}
