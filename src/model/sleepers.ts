/**
 * How much more a player's rest of season is worth than his price says.
 *
 * A projection ranks players by the points it expects, which puts the
 * expensive ones on top and tells a drafter nothing he did not know in
 * August. This ranks the market's error instead. One ridge fit predicts
 * the rest of a season from what was known by the end of a week. Ask it
 * about the player, then ask it again about a player at the same price
 * and position whose form is average for that position. The gap between
 * the two numbers is the score, and the reasons come with it.
 *
 * Every number comes off the cut week or earlier, and the fit for one
 * season reads only seasons before it, so a backtest cannot peek.
 */

import { fitRidge, predictRidge } from "../backtest/ridge.js";

/**
 * Where a rotational player stops and a starter begins, which is the cut
 * the leverage probe measured at.
 */
const ROTATIONAL = 0.15;

/**
 * What a player nobody drafted is priced at. A board runs to about 180
 * picks, so this is past the end of the deepest one, which is where the
 * curve is flat anyway.
 */
export const UNDRAFTED_PRICE = 220;

/**
 * How hard the ridge pulls, as a share of the rows it is fitted on. A
 * fixed lambda would shrink a fit on one season far harder than a fit on
 * seven, and the pull should mean the same wherever the bench starts.
 */
export const LAMBDA_SHARE = 0.01;

/** one player as of a cut week, with nothing in it from later */
export interface PlayerCut {
  season: number;
  /** the last week that may be read, and nothing after it */
  week: number;
  playerId: string;
  playerName: string;
  position: string;
  /** his average draft position, or `UNDRAFTED_PRICE` if nobody took him */
  price: number;
  drafted: boolean;
  /** what players bought at his price averaged, and how wide they ran */
  priceMedian: number;
  priceP10: number;
  priceP90: number;
  /** the chance the curve gives a player at his price of starting */
  priceHitRate: number;
  /** his cut of his side's targets and carries, as it was */
  rawWorkShare: number;
  /** and the same with every play weighted by how open the game still was */
  leverageWorkShare: number;
  /** his last three weeks of share against everything before them */
  trend: number;
  /** the same two trends apart, for the fits that read them separately */
  targetTrend?: number;
  carryTrend?: number;
  /** PPR points a game over the weeks he played up to the cut */
  ppgSoFar: number;
  gamesPlayed: number;
  /**
   * How far his pick moved across the sampled drafts, as a share of the
   * pick itself, since a tenth rounder's pick moves rounds where a first
   * rounder's moves picks. Zero when the board does not say.
   */
  pickSpread: number;
  hasPickSpread: boolean;
  /**
   * What the in-season update makes of him from here: his preseason
   * anchor moved by his usage and his scoring so far.
   */
  inSeasonPpg: number;
  /** what his usage alone pays, with his own scoring rate left out */
  roleLevelPpg: number;
}

/** one cut week and what the player went on to do after it */
export interface SleeperExample {
  cut: PlayerCut;
  /**
   * PPR points a game over the rest of the season, divided by the games
   * his side played rather than the ones he played, so a player who got
   * hurt in November is worth what he was worth.
   */
  restOfSeasonPpg: number;
}

/**
 * Leverage weighted share for the players under 15% of their side's work
 * and raw share for everybody above it. The leverage probe found the
 * weighting only beats raw share in that cohort, where a rotational
 * back's carry share orders the next four weeks at .238 against raw
 * share's .216, and found it flat or worse for everybody else.
 */
export function shareToRead(cut: PlayerCut): number {
  return cut.rawWorkShare < ROTATIONAL
    ? cut.leverageWorkShare
    : cut.rawWorkShare;
}

interface Term {
  name: string;
  of: (cut: PlayerCut) => number;
}

const at = (position: string) => (cut: PlayerCut) =>
  cut.position === position ? 1 : 0;

/**
 * What the August board already says. Holding these where the player has
 * them and everything else at the average is what "his price alone"
 * means, so the position belongs here too: a cheap tight end and a cheap
 * back are different bets and neither one is an error.
 */
const PRICE_TERMS: Term[] = [
  { name: "price median", of: (cut) => cut.priceMedian },
  {
    name: "price width",
    of: (cut) => (cut.priceP90 - cut.priceP10) / Math.max(1, cut.priceMedian),
  },
  { name: "price hit rate", of: (cut) => cut.priceHitRate },
  { name: "off the board", of: (cut) => (cut.hasPickSpread ? 0 : 1) },
  { name: "is RB", of: at("RB") },
  { name: "is WR", of: at("WR") },
  { name: "is TE", of: at("TE") },
];

/**
 * What has happened since, plus the room's own disagreement. The spread
 * is here rather than beside the price because the price curve does not
 * contain it: at a fixed price the widest third by pick spread started
 * 33.3% of the time against the tightest third's 40.3%.
 */
const FORM_TERMS: Term[] = [
  { name: "work share", of: shareToRead },
  {
    name: "leverage lift",
    of: (cut) => cut.leverageWorkShare - cut.rawWorkShare,
  },
  { name: "trend", of: (cut) => cut.trend },
  { name: "points a game so far", of: (cut) => cut.ppgSoFar },
  { name: "games played", of: (cut) => cut.gamesPlayed },
  { name: "pick spread", of: (cut) => cut.pickSpread },
];

/**
 * A player can score well and then get hurt, and he can score badly on
 * work that pays in December, so the sets below take his own scoring
 * rate back out and leave the fit the usage and the board.
 */
const SCORING_RATE = "points a game so far";

const USAGE_TERMS = FORM_TERMS.filter((term) => term.name !== SCORING_RATE);

/** the trend split back into the two kinds of work it was summed from */
const SPLIT_TREND: Term[] = [
  { name: "target trend", of: (cut) => cut.targetTrend ?? 0 },
  { name: "carry trend", of: (cut) => cut.carryTrend ?? 0 },
];

const withSplitTrend = (terms: Term[]): Term[] =>
  terms.flatMap((term) => (term.name === "trend" ? SPLIT_TREND : [term]));

/**
 * What the in-season update says, which the rest of the form terms only
 * see the ingredients of. Kept apart from `FORM_TERMS` so a fit can be
 * taken with them and without them and the two compared.
 */
const IN_SEASON_TERMS: Term[] = [
  { name: "in-season level", of: (cut) => cut.inSeasonPpg },
  { name: "role level", of: (cut) => cut.roleLevelPpg },
];

const ROLE_LEVEL = IN_SEASON_TERMS[1]!;

/** which form terms a fit reads */
export type SleeperTermSet =
  | "shipped"
  | "with in-season"
  | "usage"
  | "usage with role"
  | "usage, split trend";

const FORM_TERMS_BY_SET: Record<SleeperTermSet, Term[]> = {
  shipped: FORM_TERMS,
  "with in-season": [...FORM_TERMS, ...IN_SEASON_TERMS],
  usage: USAGE_TERMS,
  // The role level is what his usage pays with his own scoring rate left
  // out, so it belongs with the usage sets rather than with the points.
  "usage with role": [...USAGE_TERMS, ROLE_LEVEL],
  "usage, split trend": withSplitTrend(USAGE_TERMS),
};

const allTerms = (terms: SleeperTermSet): Term[] =>
  [...PRICE_TERMS, ...FORM_TERMS_BY_SET[terms]];

/** what a caller who does not ask for a set gets */
export const SHIPPED_TERM_SET: SleeperTermSet = "shipped";

/** every term a fit reads, in the order its weights come in */
export const sleeperTermNames = (
  terms: SleeperTermSet = SHIPPED_TERM_SET,
): readonly string[] => allTerms(terms).map((term) => term.name);

export const SLEEPER_TERMS = sleeperTermNames();

/** how many leading columns the price accounts for, the intercept included */
const PRICE_COLUMNS = PRICE_TERMS.length + 1;

/** the raw value of every term, in `sleeperTermNames` order */
export const termValues = (
  cut: PlayerCut, terms: SleeperTermSet = SHIPPED_TERM_SET,
): number[] => allTerms(terms).map((term) => term.of(cut));

/** what each term averaged and varied by over the rows behind a fit */
interface Scaling {
  terms: SleeperTermSet;
  means: number[];
  deviations: number[];
}

export interface SleeperFit extends Scaling {
  /** the seasons the rows came from */
  trainedOn: number[];
  examples: number;
  /** the intercept, then one weight per term in the order of this term set */
  weights: number[];
  /**
   * What each form term averaged inside one position, standardized. A
   * cheap quarterback scores more than the average player at any price,
   * so measuring him against everybody would hand every quarterback a
   * claim against the board he has not earned.
   */
  formMeans: Record<string, number[]>;
  pooledFormMeans: number[];
}

const mean = (values: number[]) =>
  values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;

function deviation(values: number[], middle: number): number {
  if (values.length < 2) {
    return 1;
  }

  const spread = mean(values.map((value) => (value - middle) ** 2));

  return spread > 1e-12 ? Math.sqrt(spread) : 1;
}

/**
 * Standardized, because one lambda over columns running from a work share
 * near 0.1 to points a game near 20 would shrink the share to nothing and
 * leave the points alone.
 */
function standardized(scaling: Scaling, cut: PlayerCut): number[] {
  const raw = termValues(cut, scaling.terms);

  return [1, ...raw.map((value, i) =>
    (value - (scaling.means[i] ?? 0)) / (scaling.deviations[i] ?? 1))];
}

export interface SleeperFitOptions {
  lambdaShare?: number;
  /** which form terms to read, the shipped set unless a caller says otherwise */
  terms?: SleeperTermSet;
}

/**
 * Fits on rows somebody else assembled. Take `fitSleepersAsOf` unless you
 * are testing, where handing in rows you made up is the only way to know
 * what the answer should be.
 */
export function fitSleepers(
  examples: SleeperExample[],
  options: SleeperFitOptions = {},
): SleeperFit {
  const { lambdaShare = LAMBDA_SHARE, terms = SHIPPED_TERM_SET } = options;
  const columns = allTerms(terms);

  if (examples.length <= columns.length) {
    throw new Error(
      `a sleeper fit wants more than ${columns.length} rows and has ` +
        `${examples.length}`,
    );
  }

  const raw = examples.map((example) => termValues(example.cut, terms));
  const means = columns.map((_, i) => mean(raw.map((row) => row[i] ?? 0)));
  const scaling: Scaling = {
    terms,
    means,
    deviations: columns.map((_, i) =>
      deviation(raw.map((row) => row[i] ?? 0), means[i] ?? 0)),
  };
  const X = examples.map((example) => standardized(scaling, example.cut));
  const y = examples.map((example) => example.restOfSeasonPpg);
  const positions = examples.map((example) => example.cut.position);

  return {
    ...scaling,
    ...formAverages(X, positions, terms),
    trainedOn: [...new Set(examples.map((one) => one.cut.season))]
      .sort((a, b) => a - b),
    examples: examples.length,
    weights: fitRidge(X, y, Math.max(1e-6, lambdaShare * examples.length)),
  };
}

/** a position with fewer rows than this reads off the pooled average */
const MIN_POSITION_ROWS = 40;

function formAverages(
  X: number[][], positions: string[], terms: SleeperTermSet,
): Pick<SleeperFit, "formMeans" | "pooledFormMeans"> {
  const columns = FORM_TERMS_BY_SET[terms].map((_, i) => PRICE_COLUMNS + i);
  const averaged = (rows: number[][]) =>
    columns.map((column) => mean(rows.map((row) => row[column] ?? 0)));
  const byPosition = new Map<string, number[][]>();

  for (let i = 0; i < X.length; i++) {
    const position = positions[i] ?? "";
    const rows = byPosition.get(position) ?? [];
    rows.push(X[i]!);
    byPosition.set(position, rows);
  }

  const formMeans: Record<string, number[]> = {};

  for (const [position, rows] of byPosition) {
    if (rows.length < MIN_POSITION_ROWS) {
      continue;
    }

    formMeans[position] = averaged(rows);
  }

  return { formMeans, pooledFormMeans: averaged(X) };
}

/**
 * The fit a drafter could have had at the end of a week of `season`.
 *
 * The rows from that season and every one after it are dropped here
 * rather than by the caller, so a bench cannot read an outcome it should
 * not know by forgetting to cut them.
 */
export function fitSleepersAsOf(
  season: number,
  examples: SleeperExample[],
  options: SleeperFitOptions = {},
): SleeperFit {
  return fitSleepers(
    examples.filter((example) => example.cut.season < season),
    options,
  );
}

/** one term, and what it did to this player's number */
export interface SleeperReason {
  term: string;
  /** how far he is from an average player at his position, in deviations */
  standoff: number;
  /** what that is worth, in points a game */
  points: number;
}

export interface SleeperScore {
  season: number;
  week: number;
  playerId: string;
  playerName: string;
  position: string;
  price: number;
  drafted: boolean;
  /** what players bought at his price averaged over a whole season */
  priceMedian: number;
  /** what the fit says he does from here */
  modelPpg: number;
  /** and what it says about a player at his price with average form */
  pricePpg: number;
  /** the gap between those two, which is the claim against the board */
  score: number;
  /** the terms that are not his price, biggest first, adding up to the score */
  reasons: SleeperReason[];
}

export function scoreSleeper(fit: SleeperFit, cut: PlayerCut): SleeperScore {
  const columns = standardized(fit, cut);
  const modelPpg = predictRidge(fit.weights, columns);
  const average = fit.formMeans[cut.position] ?? fit.pooledFormMeans;
  const reasons = FORM_TERMS_BY_SET[fit.terms].map((term, i) => {
    const column = PRICE_COLUMNS + i;
    const standoff = (columns[column] ?? 0) - (average[i] ?? 0);

    return {
      term: term.name,
      standoff,
      points: (fit.weights[column] ?? 0) * standoff,
    };
  }).sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  const score = reasons.reduce((sum, one) => sum + one.points, 0);

  return {
    season: cut.season,
    week: cut.week,
    playerId: cut.playerId,
    playerName: cut.playerName,
    position: cut.position,
    price: cut.price,
    drafted: cut.drafted,
    priceMedian: cut.priceMedian,
    modelPpg,
    pricePpg: modelPpg - score,
    score,
    reasons,
  };
}

/** every player scored, the biggest claim against the board first */
export function rankSleepers(
  fit: SleeperFit,
  cuts: PlayerCut[],
): SleeperScore[] {
  return cuts
    .map((cut) => scoreSleeper(fit, cut))
    .sort((a, b) => b.score - a.score);
}
