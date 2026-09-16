/**
 * What a player should be worth over the rest of the season, once some
 * of it has been played.
 *
 * The board's preseason number never moves on its own, so by the time
 * the weekly fade hands back to it the model is saying the August
 * prior was right whatever the player has done since. This reads the
 * season so far and moves the level.
 *
 * Usage and points are read separately. A player's usage says what his
 * role is and settles inside three games, while his points stay noisy
 * for much longer because touchdowns arrive in lumps. They get their
 * own weights, both growing with the games behind them, both fitted.
 */

import { fitRidge, predictRidge } from "../backtest/ridge.js";

/** one game a player played, as the update reads it */
export interface PlayedWeek {
  week: number;
  points: number;
  /** share of his side's offensive snaps, 0 where snap counts are missing */
  snapShare: number;
  targets: number;
  carries: number;
  airYards: number;
  /** his own pass attempts, which is what a quarterback's role comes down to */
  passAttempts: number;
}

/** a player's workload for an average game of some window */
export interface UsagePerGame {
  snapShare: number;
  targets: number;
  carries: number;
  airYards: number;
  passAttempts: number;
}

const ROLE_POSITIONS = ["QB", "RB", "WR", "TE"];
/** below this a position gets the pooled weights instead of its own */
const MIN_ROLE_ROWS = 120;

/**
 * Workload divided down to roughly the same size, so one ridge penalty
 * means about the same thing on every column.
 */
export function usageRow(usage: UsagePerGame): number[] {
  return [
    1,
    usage.snapShare,
    usage.targets / 5,
    usage.carries / 10,
    usage.airYards / 50,
    usage.passAttempts / 30,
  ];
}

export interface RoleLevelRow {
  position: string;
  usage: UsagePerGame;
  ppg: number;
}

export interface RoleLevelFit {
  byPosition: Map<string, number[]>;
  pooled: number[];
}

/**
 * What a role like this usually pays. Trained on whole player seasons
 * from earlier years, where workload and scoring are measured over the
 * same games, so the fit says nothing about the future and can be
 * pointed at a three game window without leaking anything.
 */
export function fitRoleLevel(rows: RoleLevelRow[]): RoleLevelFit {
  const pooled = fitRidge(
    rows.map((r) => usageRow(r.usage)),
    rows.map((r) => r.ppg),
    5,
  );
  const byPosition = new Map<string, number[]>();

  for (const position of ROLE_POSITIONS) {
    const his = rows.filter((r) => r.position === position);

    if (his.length < MIN_ROLE_ROWS) {
      continue;
    }

    byPosition.set(
      position,
      fitRidge(his.map((r) => usageRow(r.usage)), his.map((r) => r.ppg), 5),
    );
  }

  return { byPosition, pooled };
}

/** points a game the usage alone implies, never below zero */
export function roleLevel(
  fit: RoleLevelFit,
  position: string,
  usage: UsagePerGame,
): number {
  const weights = fit.byPosition.get(position) ?? fit.pooled;

  return Math.max(0, predictRidge(weights, usageRow(usage)));
}

/**
 * The knobs the combiner fits. `decay` weights the latest game against
 * the one before it. `breakGap` is the snap share move that counts as
 * a role changing outright, above which only the games since the move
 * are read; Infinity turns that off. The caps are how much of the
 * final number each source can ever take, and the games figures are
 * how many games it takes to reach half of that cap.
 */
export interface UpdateShape {
  decay: number;
  breakGap: number;
  roleCap: number;
  roleGames: number;
  pointsCap: number;
  pointsGames: number;
}

export interface InSeasonFit {
  role: RoleLevelFit;
  shape: UpdateShape;
}

/** how much of the final number can come from this season at most */
const MOST_FROM_SEASON = 0.95;
/** games at the end of the window a break is looked for over */
const BREAK_WINDOW = 3;

/**
 * Where a role changed outright, the games before it say nothing about
 * what comes next, so they are dropped. A starter going down or a
 * rookie taking the job moves snap share in one step, which is why
 * that is what the break is read off rather than points.
 */
export function gamesSinceBreak(
  weeks: PlayedWeek[],
  breakGap: number,
): PlayedWeek[] {
  if (weeks.length <= BREAK_WINDOW || !Number.isFinite(breakGap)) {
    return weeks;
  }

  const recent = weeks.slice(-BREAK_WINDOW);
  const earlier = weeks.slice(0, -BREAK_WINDOW);
  const mean = (some: PlayedWeek[]) =>
    some.reduce((sum, w) => sum + w.snapShare, 0) / some.length;

  if (Math.abs(mean(recent) - mean(earlier)) < breakGap) {
    return weeks;
  }

  return recent;
}

export interface WindowSummary {
  usage: UsagePerGame;
  toDatePpg: number;
  /**
   * Games the window is worth once recency has been applied, so a long
   * stretch read with a hard decay is not treated as a large sample.
   */
  effectiveGames: number;
}

/** the window a level is read off, latest games counting most */
export function summarizeWindow(
  weeks: PlayedWeek[],
  shape: UpdateShape,
): WindowSummary {
  const kept = gamesSinceBreak(weeks, shape.breakGap);
  const last = kept.length - 1;
  const weights = kept.map((_, i) => shape.decay ** (last - i));
  const total = weights.reduce((sum, w) => sum + w, 0);
  const spread = weights.reduce((sum, w) => sum + w * w, 0);
  const mean = (of: (w: PlayedWeek) => number) =>
    kept.reduce((sum, w, i) => sum + weights[i]! * of(w), 0) / total;

  return {
    usage: {
      snapShare: mean((w) => w.snapShare),
      targets: mean((w) => w.targets),
      carries: mean((w) => w.carries),
      airYards: mean((w) => w.airYards),
      passAttempts: mean((w) => w.passAttempts),
    },
    toDatePpg: mean((w) => w.points),
    effectiveGames: (total * total) / spread,
  };
}

export interface UpdateInput {
  /** the board's preseason points a game, which is the prior */
  anchor: number;
  position: string;
  /** the games he has played this season, earliest first */
  weeks: PlayedWeek[];
}

export interface UpdatedLevel {
  /** points a game to expect over his remaining games */
  ppg: number;
  /** what his usage alone says he is worth */
  roleLevel: number;
  /** what he has actually averaged, latest games counting most */
  toDatePpg: number;
  weightOnRole: number;
  weightOnPoints: number;
}

function shrink(games: number, half: number): number {
  return games / (games + half);
}

/**
 * How much of the number the two in-season sources take. Each grows
 * toward its own cap with the games behind it, and the pair is scaled
 * back together where they would leave the prior almost nothing.
 */
function sourceWeights(
  games: number,
  shape: UpdateShape,
): { onRole: number; onPoints: number } {
  const onRole = shape.roleCap * shrink(games, shape.roleGames);
  const onPoints = shape.pointsCap * shrink(games, shape.pointsGames);
  const fromSeason = onRole + onPoints;

  if (fromSeason <= MOST_FROM_SEASON) {
    return { onRole, onPoints };
  }

  const back = MOST_FROM_SEASON / fromSeason;

  return { onRole: onRole * back, onPoints: onPoints * back };
}

/** the preseason number updated by what the season has shown */
export function updateLevel(
  fit: InSeasonFit,
  input: UpdateInput,
): UpdatedLevel {
  if (input.weeks.length === 0) {
    return {
      ppg: input.anchor,
      roleLevel: input.anchor,
      toDatePpg: input.anchor,
      weightOnRole: 0,
      weightOnPoints: 0,
    };
  }

  const window = summarizeWindow(input.weeks, fit.shape);
  const level = roleLevel(fit.role, input.position, window.usage);
  const { onRole, onPoints } = sourceWeights(
    window.effectiveGames,
    fit.shape,
  );

  return {
    ppg: Math.max(
      0,
      (1 - onRole - onPoints) * input.anchor +
        onRole * level +
        onPoints * window.toDatePpg,
    ),
    roleLevel: level,
    toDatePpg: window.toDatePpg,
    weightOnRole: onRole,
    weightOnPoints: onPoints,
  };
}

/** one player at one cut, for fitting the weights */
export interface UpdateCase {
  position: string;
  anchor: number;
  weeks: PlayedWeek[];
  /** what he went on to average over the games after the cut */
  restPpg: number;
}

const DECAYS = [1, 0.9, 0.8, 0.7, 0.6];
const BREAK_GAPS = [Infinity, 0.3, 0.2, 0.15];
const CAPS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
const HALVES = [0.5, 1, 2, 3, 5, 8, 12];

const BASE_SHAPE: UpdateShape = {
  decay: 1,
  breakGap: Infinity,
  roleCap: 0.4,
  roleGames: 3,
  pointsCap: 0.3,
  pointsGames: 5,
};

/**
 * A training case with everything that does not depend on the weights
 * worked out already, so the search over caps and half-game figures is
 * arithmetic over arrays.
 */
interface ReadCase {
  anchor: number;
  level: number;
  toDate: number;
  games: number;
  restPpg: number;
}

function readCases(
  role: RoleLevelFit,
  cases: UpdateCase[],
  decay: number,
  breakGap: number,
): ReadCase[] {
  return cases.map((c) => {
    const window = summarizeWindow(c.weeks, { ...BASE_SHAPE, decay, breakGap });

    return {
      anchor: c.anchor,
      level: roleLevel(role, c.position, window.usage),
      toDate: window.toDatePpg,
      games: window.effectiveGames,
      restPpg: c.restPpg,
    };
  });
}

function meanError(read: ReadCase[], shape: UpdateShape): number {
  let total = 0;

  for (const c of read) {
    const { onRole, onPoints } = sourceWeights(c.games, shape);
    const said =
      (1 - onRole - onPoints) * c.anchor + onRole * c.level + onPoints * c.toDate;
    total += Math.abs(Math.max(0, said) - c.restPpg);
  }

  return total / Math.max(1, read.length);
}

/** the four weight knobs and the values each is tried at */
const KNOBS: [keyof UpdateShape, number[]][] = [
  ["roleCap", CAPS],
  ["roleGames", HALVES],
  ["pointsCap", CAPS],
  ["pointsGames", HALVES],
];

const ROUNDS = 3;

/** the best the four weight knobs do on one reading of the windows */
function bestWeights(
  read: ReadCase[],
  start: UpdateShape,
  fixed: Partial<UpdateShape>,
): { shape: UpdateShape; error: number } {
  let shape = start;
  let error = meanError(read, shape);

  for (let round = 0; round < ROUNDS; round++) {
    for (const [knob, values] of KNOBS) {
      if (fixed[knob] !== undefined) {
        continue;
      }

      for (const value of values) {
        const tried = { ...shape, [knob]: value };
        const tryError = meanError(read, tried);

        if (tryError < error - 1e-9) {
          error = tryError;
          shape = tried;
        }
      }
    }
  }

  return { shape, error };
}

/**
 * The weights, by whichever setting predicts the rest of the training
 * seasons best. Recency and the break threshold change what the window
 * says, so each pair of them is read once, and the four weight knobs
 * are settled inside it one at a time over a few rounds. Anything
 * given in `fixed` is held there instead of searched, which is how a
 * caller marks one part of the update against the update without it.
 */
export function fitUpdateShape(
  role: RoleLevelFit,
  cases: UpdateCase[],
  fixed: Partial<UpdateShape> = {},
): UpdateShape {
  let best = { ...BASE_SHAPE, ...fixed };
  let bestError = Infinity;

  for (const decay of fixed.decay === undefined ? DECAYS : [fixed.decay]) {
    const gaps = fixed.breakGap === undefined ? BREAK_GAPS : [fixed.breakGap];

    for (const breakGap of gaps) {
      const read = readCases(role, cases, decay, breakGap);
      const start = { ...BASE_SHAPE, ...fixed, decay, breakGap };
      const found = bestWeights(read, start, fixed);

      if (found.error < bestError) {
        bestError = found.error;
        best = found.shape;
      }
    }
  }

  return best;
}

export function fitInSeasonUpdate(
  roleRows: RoleLevelRow[],
  cases: UpdateCase[],
  fixed: Partial<UpdateShape> = {},
): InSeasonFit {
  const role = fitRoleLevel(roleRows);

  return { role, shape: fitUpdateShape(role, cases, fixed) };
}
