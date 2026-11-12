/**
 * A skill player's next three seasons, from what is known at one week of
 * this one.
 *
 * Each season ahead is two numbers, because the app wants them apart: his
 * points a game when he plays, and the games he plays out of seventeen,
 * where a man out of the league plays none. Each is a ridge fit per
 * position, taught on earlier seasons cut at the same week, and the two
 * multiplied are his season.
 *
 * What a player has done this season and last carries most of it, with
 * the square of it beside it, since how long a man lasts rises faster
 * than his rate does. Age
 * moves it at every horizon, and draft capital moves a player in his
 * first three seasons, which is what a rookie taken third overall and
 * hurt in November is mostly made of. `scripts/README.md` has which terms
 * earned their place and which did not: the injury list, the room he
 * plays in, the trend in his snaps and the season before last all came
 * out level or worse on seasons the fit had not seen, and are left out.
 */

import { fitRidge, predictRidge } from "../backtest/ridge.js";
import { scalingFor, standardizedRow, type TermScaling } from "./termScaling.js";
import {
  AHEAD_POSITIONS, HORIZONS, type AheadRow, type Drafted,
} from "../features/aheadRows.js";

const GAMES = 17;

/** the pick past which the draft says nothing about a player */
const LAST_PICK = 260;

/** the seasons his draft capital is still read for, from his first */
const CAPITAL_SEASONS = 3;

/**
 * How much of last season goes in beside this one in the shrunk rate.
 * Half: this season is the more recent read, last season the longer one.
 */
const LAST_SEASON_WEIGHT = 0.5;

/** the age the curve bends around */
const MIDDLE_AGE = 26;

/** what a player with no birth date is read as */
const UNKNOWN_AGE = 26;

/**
 * The penalty on every fit. Swept on the development seasons: 3 and 10
 * are the same to a tenth of a point, 30 costs two to four tenths of a
 * season point and 100 costs one.
 */
export const AHEAD_LAMBDA = 10;

/** his points a game so far this season, nought before he has played */
export const ppgOf = (row: Pick<AheadRow, "points" | "games">): number =>
  row.games > 0 ? row.points / row.games : 0;

/**
 * Every term a fit could read, named so the bench can put one in or take
 * one out and say what it was worth. The shipped fit reads
 * `SHIPPED_TERMS`; the rest were measured and lost.
 */
export const AHEAD_TERMS = [
  "points a game so far",
  "share of his club's games played",
  "games so far",
  "points a game last season",
  "games last season",
  "points a game, this season and last",
  "the same, squared",
  "age",
  "age, squared about 26",
  "seasons in the league",
  "rookie",
  "draft capital, first three seasons",
  "undrafted",
  "snap share",
  "share of the work at his position",
  // measured and left out
  "snap trend",
  "work share trend",
  "on a reserve list",
  "on a practice squad",
  "off his club's roster",
  "busiest teammate's share",
  "young high pick in his room",
  "points a game the season before last",
  "games the season before last",
  "draft capital, every season",
  "first round pick",
] as const;

export type AheadTerm = typeof AHEAD_TERMS[number];

/**
 * What did not earn a place, on the development seasons of
 * `scripts/seasonsAheadEval.ts --ablate`. The trends in his snaps and
 * his share were level; whether his club had him on a reserve list was
 * worse at every horizon, since the games he has already missed say it
 * first; the room he plays in was level; the season before last and draft
 * capital past his third season were slightly worse.
 */
export const LEFT_OUT: AheadTerm[] = [
  "snap trend",
  "work share trend",
  "on a reserve list",
  "on a practice squad",
  "off his club's roster",
  "busiest teammate's share",
  "young high pick in his room",
  "points a game the season before last",
  "games the season before last",
  "draft capital, every season",
  "first round pick",
];

export const SHIPPED_TERMS: AheadTerm[] = AHEAD_TERMS
  .filter((term) => !LEFT_OUT.includes(term));

/** how much a pick is worth, nought past the last one */
export const capitalOf = (drafted: Pick<Drafted, "overall"> | null | undefined): number =>
  drafted
    ? Math.max(0, Math.log(LAST_PICK) - Math.log(Math.min(LAST_PICK, Math.max(1, drafted.overall))))
    : 0;

/** every term a row could be read on, in `AHEAD_TERMS` order */
export function aheadTerms(row: AheadRow): number[] {
  const ppg = ppgOf(row);
  const lastGames = row.last?.games ?? 0;
  const lastPoints = row.last?.points ?? 0;
  const lastPpg = lastGames > 0 ? lastPoints / lastGames : 0;
  const pooled = row.games + LAST_SEASON_WEIGHT * lastGames;
  const age = row.age ?? UNKNOWN_AGE;
  const beforeGames = row.before?.games ?? 0;
  const both = pooled > 0 ? (row.points + LAST_SEASON_WEIGHT * lastPoints) / pooled : 0;

  return [
    ppg,
    row.clubGames > 0 ? row.games / row.clubGames : 0,
    row.games,
    lastPpg,
    lastGames,
    both,
    // a good player stays in the league and on the field, and a straight
    // line through his rate cannot say so: without this a man scoring
    // fourteen a game was held 23 points a season short three years on
    both * both,
    age,
    (age - MIDDLE_AGE) ** 2,
    row.experience,
    row.experience === 0 ? 1 : 0,
    row.experience < CAPITAL_SEASONS ? capitalOf(row.drafted) : 0,
    row.drafted ? 0 : 1,
    row.snapShare ?? 0,
    row.share ?? 0,
    row.snapTrend ?? 0,
    row.shareTrend ?? 0,
    row.standing === "reserve" ? 1 : 0,
    row.standing === "practice" ? 1 : 0,
    row.standing === "off" ? 1 : 0,
    row.roomTopShare,
    row.roomYoungPick === undefined ? 0 : capitalOf({ overall: row.roomYoungPick }),
    beforeGames > 0 ? row.before!.points / beforeGames : 0,
    beforeGames,
    capitalOf(row.drafted),
    row.drafted?.round === 1 ? 1 : 0,
  ];
}

/** one ridge fit and the scaling it was fitted under */
interface Fitted {
  scaling: TermScaling;
  weights: number[];
  /** the target's weighted mean, taken off before the fit and put back */
  centre: number;
  keep: number[];
}

/**
 * A weighted ridge: each row counts for its weight, which is the same as
 * scaling it by the root of it. The target is centred first so the
 * penalty never pulls the level toward nought.
 */
function fitWeighted(
  raw: number[][], targets: number[], weights: number[], lambda: number, keep: number[],
): Fitted {
  const picked = raw.map((terms) => keep.map((i) => terms[i]!));
  const scaling = scalingFor(picked);
  const total = weights.reduce((a, b) => a + b, 0);
  const centre = total > 0
    ? targets.reduce((sum, y, i) => sum + y * weights[i]!, 0) / total
    : 0;
  const X = picked.map((terms, i) =>
    standardizedRow(scaling, terms).map((x) => x * Math.sqrt(weights[i]!)));
  const y = targets.map((target, i) => (target - centre) * Math.sqrt(weights[i]!));

  return { scaling, weights: fitRidge(X, y, lambda), centre, keep };
}

function predictFitted(fit: Fitted, terms: number[]): number {
  return fit.centre + predictRidge(
    fit.weights, standardizedRow(fit.scaling, fit.keep.map((i) => terms[i]!)));
}

/** a season ahead: points a game when he plays, and games out of seventeen */
export interface SeasonAhead {
  ppg: number;
  games: number;
}

export interface AheadFit {
  horizon: number;
  byPosition: Map<string, { ppg: Fitted; games: Fitted }>;
}

export interface AheadOptions {
  lambda?: number;
  /** the terms to read, for the bench to measure what each is worth */
  terms?: AheadTerm[];
}

/** the rows a horizon can be taught on: those whose season that far on is over */
export const taughtOn = (rows: AheadRow[], horizon: number): AheadRow[] =>
  rows.filter((row) => row.ahead[horizon - 1] !== undefined);

/**
 * One fit per position for one horizon. The rate is taught on the
 * players who played that season, each counted by the games he played,
 * and the games on everybody, so a man who left the league teaches the
 * games fit his nought.
 */
export function fitAhead(
  rows: AheadRow[], horizon: number, options: AheadOptions = {},
): AheadFit {
  const lambda = options.lambda ?? AHEAD_LAMBDA;
  const reading = options.terms ?? SHIPPED_TERMS;
  const keep = AHEAD_TERMS
    .map((term, i) => [term, i] as const)
    .filter(([term]) => reading.includes(term))
    .map(([, i]) => i);
  const byPosition = new Map<string, { ppg: Fitted; games: Fitted }>();

  for (const position of AHEAD_POSITIONS) {
    const mine = taughtOn(rows, horizon).filter((row) => row.position === position);
    const played = mine.filter((row) => row.ahead[horizon - 1]!.games >= 1);

    if (played.length < 20) {
      continue;
    }

    const termsOf = new Map(mine.map((row) => [row, aheadTerms(row)]));

    byPosition.set(position, {
      ppg: fitWeighted(
        played.map((row) => termsOf.get(row)!),
        played.map((row) => row.ahead[horizon - 1]!.points / row.ahead[horizon - 1]!.games),
        played.map((row) => Math.min(GAMES, row.ahead[horizon - 1]!.games) / GAMES),
        lambda, keep,
      ),
      games: fitWeighted(
        mine.map((row) => termsOf.get(row)!),
        mine.map((row) => row.ahead[horizon - 1]!.games),
        mine.map(() => 1),
        lambda, keep,
      ),
    });
  }

  return { horizon, byPosition };
}

/** what the fit says of him, nothing for a position it was never taught */
export function predictAhead(fit: AheadFit, row: AheadRow): SeasonAhead | undefined {
  const his = fit.byPosition.get(row.position);

  if (!his) {
    return undefined;
  }

  const terms = aheadTerms(row);

  return {
    ppg: Math.max(0, predictFitted(his.ppg, terms)),
    games: Math.min(GAMES, Math.max(0, predictFitted(his.games, terms))),
  };
}

/** every horizon at once, from the rows the board's season can be taught on */
export function fitSeasonsAhead(rows: AheadRow[], options: AheadOptions = {}): AheadFit[] {
  return Array.from({ length: HORIZONS }, (_, k) => fitAhead(rows, k + 1, options));
}

/* ---------- the two readers the model has to beat ---------- */

/**
 * This season's rate and his share of the games, carried forward as they
 * are. A man traded across two byes can have played more games than his
 * new club has, so the share stops at all of them.
 */
export function carriedForward(row: AheadRow): SeasonAhead {
  return {
    ppg: ppgOf(row),
    games: row.clubGames > 0 ? Math.min(GAMES, GAMES * row.games / row.clubGames) : 0,
  };
}

/** a quadratic in age, about MIDDLE_AGE + 1 */
type Curve = [number, number, number];

export interface AgeCurve {
  horizon: number;
  byPosition: Map<string, { ppg: Curve; games: Curve }>;
}

const YOUNGEST = 21;
const OLDEST = 36;
const CURVE_MIDDLE = 27;

/**
 * The share of a quantity players of one age keep a horizon on, as a
 * quadratic in age fitted to the ratio of sums at each age, each age
 * counted by how much it has to divide. A curve, not a table, so an age
 * with three players in it does not decide its own number.
 */
function curveThrough(byAge: Map<number, { kept: number; had: number }>): Curve {
  const ages = [...byAge].filter(([, sums]) => sums.had > 0);

  if (ages.length < 3) {
    const kept = ages.reduce((sum, [, s]) => sum + s.kept, 0);
    const had = ages.reduce((sum, [, s]) => sum + s.had, 0);

    return [had > 0 ? kept / had : 1, 0, 0];
  }

  const X = ages.map(([age, s]) => {
    const x = age - CURVE_MIDDLE;
    const root = Math.sqrt(s.had);

    return [root, x * root, x * x * root];
  });
  const y = ages.map(([, s]) => (s.kept / s.had) * Math.sqrt(s.had));
  const [a, b, c] = fitRidge(X, y, 1e-6);

  return [a!, b!, c!];
}

const binOf = (age: number | undefined) =>
  Math.round(Math.min(OLDEST, Math.max(YOUNGEST, age ?? UNKNOWN_AGE)));

/** the minimum games this season for his rate to say how it ages */
const CURVE_GAMES = 4;

/**
 * How much of his points a game and of his games a player of each age
 * keeps a horizon on, per position. Points are counted over the games
 * he did play; games are counted over everybody, so leaving the league
 * is in the curve.
 */
export function fitAgeCurve(rows: AheadRow[], horizon: number): AgeCurve {
  const byPosition = new Map<string, { ppg: Curve; games: Curve }>();

  for (const position of AHEAD_POSITIONS) {
    const rate = new Map<number, { kept: number; had: number }>();
    const games = new Map<number, { kept: number; had: number }>();

    for (const row of taughtOn(rows, horizon)) {
      if (row.position !== position || row.games < 1) {
        continue;
      }

      const later = row.ahead[horizon - 1]!;
      const bin = binOf(row.age);
      const now = carriedForward(row);

      if (row.games >= CURVE_GAMES && later.games >= 1) {
        const sums = rate.get(bin) ?? { kept: 0, had: 0 };
        sums.kept += later.points;
        sums.had += now.ppg * later.games;
        rate.set(bin, sums);
      }

      const sums = games.get(bin) ?? { kept: 0, had: 0 };
      sums.kept += later.games;
      sums.had += now.games;
      games.set(bin, sums);
    }

    byPosition.set(position, { ppg: curveThrough(rate), games: curveThrough(games) });
  }

  return { horizon, byPosition };
}

const onCurve = ([a, b, c]: Curve, age: number | undefined) => {
  const x = binOf(age) - CURVE_MIDDLE;

  return a + b * x + c * x * x;
};

/** this season carried forward, aged by the curve and nothing else */
export function ageCurved(curve: AgeCurve, row: AheadRow): SeasonAhead {
  const now = carriedForward(row);
  const his = curve.byPosition.get(row.position);

  if (!his) {
    return now;
  }

  return {
    ppg: Math.max(0, now.ppg * onCurve(his.ppg, row.age)),
    games: Math.min(GAMES, Math.max(0, now.games * onCurve(his.games, row.age))),
  };
}

/* ---------- who the bench marks ---------- */

/** a rate below this is not a player anybody is rostering for it */
const RELEVANT_PPG = 5;

/**
 * The players a keeper or dynasty league is choosing between, read off
 * the cut alone so no reader is marked on a set picked by what happened:
 * with his club or on its reserve list, and either scoring five a game
 * over two games or more this season, or over four last season, or in
 * his first three seasons from the first three rounds.
 */
export function isRelevant(row: AheadRow): boolean {
  if (row.standing !== "active" && row.standing !== "reserve") {
    return false;
  }

  const lastPpg = row.last && row.last.games > 0 ? row.last.points / row.last.games : 0;

  return (row.games >= 2 && ppgOf(row) >= RELEVANT_PPG) ||
    ((row.last?.games ?? 0) >= 4 && lastPpg >= RELEVANT_PPG) ||
    (row.drafted !== null && row.drafted.round <= 3 && row.experience < CAPITAL_SEASONS);
}

/* ---------- what the board writes ---------- */

/** below this the board's own rate is too small to be a ratio of */
export const LEAST_BOARD_PPG = 1;

/**
 * His seasons ahead as the board writes them: points a game as a multiple
 * of the board's own `ppg` for him, so a page in another league's scoring
 * can rescore them, and games out of seventeen. Nothing where his board
 * rate is too small to divide by or a season has no answer.
 */
export function aheadField(
  seasons: (SeasonAhead | undefined)[], boardPpg: number,
): { of: number; games: number }[] | undefined {
  if (!(boardPpg >= LEAST_BOARD_PPG) || seasons.length !== HORIZONS ||
      seasons.some((s) => s === undefined)) {
    return undefined;
  }

  return seasons.map((s) => ({
    of: Number((s!.ppg / boardPpg).toFixed(3)),
    games: Number(s!.games.toFixed(1)),
  }));
}
