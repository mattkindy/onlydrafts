/**
 * What a backup would be worth if the job in front of him opened.
 *
 * The shipped sleeper score finds a player who has already outscored his
 * price, which is a waiver pickup. This asks a different question, in two
 * parts a caller can read separately. `wouldAverage` is his points per
 * opportunity, shrunk hard toward the position by how few he has, times
 * the opportunities a next man up at his position actually inherits.
 * `roleChance` is a ridge fit on earlier seasons giving the chance he
 * goes on to average a starter's share of the snaps. The score multiplies
 * the two and takes off what a player at his price averages.
 *
 * Nothing here reads a week after the cut. `scripts/README.md` has why.
 */

import { fitRidge, predictRidge } from "../backtest/ridge.js";

/**
 * How many opportunities it takes before a player's own rate outweighs
 * the position's. Over the 752 backups of 2015 to 2018 who went on to
 * play a starter's share, the rate they had scored at before the job
 * opened predicted the rate they scored at with it at a slope of 0.12,
 * on a mean of 35 opportunities behind them. A slope that flat asks for
 * a weight near 250, which is where these sit. The quarterback figure is
 * higher for the same reason it always was: he gets thirty chances a
 * game rather than six, so it takes more of them to mean as much.
 */
const SHRINK_OPPORTUNITIES: Record<string, number> = {
  QB: 600, RB: 250, WR: 250, TE: 250,
};

const DEFAULT_SHRINK = 250;

/**
 * What last season's opportunities count for against this season's. Below
 * one because a player changes clubs, bodies and coaches over a winter,
 * and above zero because six carries in October say less about him than a
 * hundred and forty last year.
 */
const LAST_SEASON_WEIGHT = 0.6;

/**
 * How far draft capital and age move the prior a player with no work of
 * his own is read at, as a share of the position mean. Both are small on
 * purpose: this is the guess a player with three carries gets, and it
 * washes out by the time he has fifty.
 */
const CAPITAL_LIFT = 0.15;
const AGE_DROP = 0.02;

/** the age the prior neither adds to a player nor takes from him */
const NEUTRAL_AGE = 25;

/** the pick past which the draft says nothing about a player */
const LAST_PICK = 256;

/** one player at one cut, with nothing in it from a later week */
export interface ContingentCut {
  season: number;
  /** the last week that may be read, and nothing after it */
  week: number;
  playerId: string;
  playerName: string;
  position: string;
  /** the club he is doing his work for */
  club: string;
  price: number;
  drafted: boolean;
  /** points a game players bought at his price have averaged */
  priceMedian: number;
  /** his own opportunities this season to the cut, and what they produced */
  opportunities: number;
  opportunityPoints: number;
  /** the same opportunities as a rate, over the games his club has played */
  ownOpportunities: number;
  /** and the same over all of last season */
  lastOpportunities: number;
  lastOpportunityPoints: number;
  /** what an opportunity is worth at his position, over the same rows */
  positionPerOpportunity: number;
  /** where he was taken, absent when nobody took him */
  draftOverall?: number;
  age?: number;
  /** opportunities a game the top man at his position on his club gets */
  starterOpportunities: number;
  /** where he ranks at his position on his club, one for the man playing */
  depthRank: number;
  /** how many teammates at his position get more opportunity than he does */
  playersAhead: number;
  /** his share of his club's offensive snaps over the weeks he played */
  snapShare: number;
  /** how old the man in front is, and how many games that man has missed */
  starterAge?: number;
  starterGamesMissed: number;
  /** weeks the man in front has been on the injury report this season */
  starterListedWeeks: number;
  /** and whether he is on it in the cut week itself */
  starterListedNow: boolean;
  /** whether his club's roster file has him as anything but active */
  starterOffRoster: boolean;
  /** his seasons in the league, absent when the roster file does not say */
  starterExperience?: number;
  /**
   * How often a starter at this position misses three or more of the
   * remaining weeks, counted over earlier seasons. It anchors a fit that
   * would otherwise read a quarterback's depth rank the way it reads a
   * back's.
   */
  positionOpenRate: number;
  /** the weeks his club still has to play */
  weeksLeft: number;
}

/**
 * The band where a backup is already splitting the job. The role can grow
 * here without anybody getting hurt, which is a different road to the
 * same place and worth its own term.
 */
const COMMITTEE_LOW = 0.30;
const COMMITTEE_HIGH = 0.45;

export const inCommittee = (cut: ContingentCut): boolean =>
  cut.snapShare >= COMMITTEE_LOW && cut.snapShare <= COMMITTEE_HIGH;

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

/**
 * What the position mean is worth to this particular player before he has
 * done anything, as a multiple of it.
 */
export function priorMultiplier(cut: ContingentCut): number {
  const pick = cut.draftOverall ?? LAST_PICK;
  const capital = CAPITAL_LIFT * (1 - 2 * clamp(pick / LAST_PICK, 0, 1));
  const age = cut.age === undefined
    ? 0
    : -AGE_DROP * (cut.age - NEUTRAL_AGE);

  return clamp(1 + capital + age, 0.5, 1.5);
}

/** his points per opportunity, pulled toward the position by how few he has */
export function shrunkEfficiency(cut: ContingentCut): number {
  const weight = SHRINK_OPPORTUNITIES[cut.position] ?? DEFAULT_SHRINK;
  const prior = cut.positionPerOpportunity * priorMultiplier(cut);
  const chances = cut.opportunities
    + LAST_SEASON_WEIGHT * cut.lastOpportunities;
  const points = cut.opportunityPoints
    + LAST_SEASON_WEIGHT * cut.lastOpportunityPoints;

  return (points + weight * prior) / (chances + weight);
}

/** what a next man up gets a game, off the job and off his own work */
interface InheritedLine {
  base: number;
  fromTheJob: number;
  fromHisOwnWork: number;
}

/**
 * Fitted on the 1004 backups of 2015 to 2018 who went on to play a
 * starter's share for three weeks or more, one line per position. The
 * job in front barely moves it: inside a position, what the man ahead
 * was getting explains about three percent of what the next man got. A
 * back behind a 28 touch workhorse and a back behind a 14 touch
 * committee both end up near eighteen. A receiver's own work does move
 * it, which is why the third number is not zero for him or for a tight
 * end. The running back line came out with both slopes slightly
 * negative, so his is the mean and nothing else.
 */
const INHERITED: Record<string, InheritedLine> = {
  QB: { base: 33.5, fromTheJob: 0.09, fromHisOwnWork: 0.08 },
  RB: { base: 18.4, fromTheJob: 0, fromHisOwnWork: 0 },
  WR: { base: 3.7, fromTheJob: 0.02, fromHisOwnWork: 0.41 },
  TE: { base: 2.3, fromTheJob: 0.02, fromHisOwnWork: 0.72 },
};

const DEFAULT_INHERITED: InheritedLine = {
  base: 3.7, fromTheJob: 0.02, fromHisOwnWork: 0.41,
};

/** the opportunities a game he would get if the job in front of him opened */
export function inheritedOpportunities(cut: ContingentCut): number {
  const line = INHERITED[cut.position] ?? DEFAULT_INHERITED;

  return Math.max(0, line.base
    + line.fromTheJob * cut.starterOpportunities
    + line.fromHisOwnWork * cut.ownOpportunities);
}

/** what he would average a game with the job in front of him open */
export function wouldAverage(cut: ContingentCut): number {
  return shrunkEfficiency(cut) * inheritedOpportunities(cut);
}

/* ---------- the chance the job opens ---------- */

interface Term {
  name: string;
  of: (cut: ContingentCut) => number;
}

const at = (position: string) => (cut: ContingentCut) =>
  cut.position === position ? 1 : 0;

/** the seasons in the league a starter is read at when the file is silent */
const TYPICAL_EXPERIENCE = 5;

/**
 * A backup two deep is closer to the job than one three deep, and a
 * backup already on the field for a fifth of the snaps is closer still.
 * The man in front is the other half, and he gets six terms of it: how
 * often he has turned up on the injury report this season, whether he is
 * on it right now, whether the roster file has taken him off active, his
 * age, his seasons in the league, and what he has missed over the last
 * two years. The position base rate anchors all of it, since a running
 * back ahead of you goes down far more often than a quarterback does.
 */
const CHANCE_TERMS: Term[] = [
  { name: "depth rank", of: (cut) => cut.depthRank },
  { name: "players ahead of him", of: (cut) => cut.playersAhead },
  { name: "snap share so far", of: (cut) => cut.snapShare },
  { name: "in a committee", of: (cut) => (inCommittee(cut) ? 1 : 0) },
  { name: "the starter's age", of: (cut) => cut.starterAge ?? NEUTRAL_AGE },
  { name: "games the starter missed", of: (cut) => cut.starterGamesMissed },
  { name: "weeks he has been listed", of: (cut) => cut.starterListedWeeks },
  { name: "he is listed now", of: (cut) => (cut.starterListedNow ? 1 : 0) },
  { name: "he is off the roster", of: (cut) => (cut.starterOffRoster ? 1 : 0) },
  {
    name: "his seasons in the league",
    of: (cut) => cut.starterExperience ?? TYPICAL_EXPERIENCE,
  },
  { name: "the position base rate", of: (cut) => cut.positionOpenRate },
  { name: "weeks left", of: (cut) => cut.weeksLeft },
  { name: "is RB", of: at("RB") },
  { name: "is WR", of: at("WR") },
  { name: "is TE", of: at("TE") },
];

export const roleChanceTermNames: readonly string[] =
  CHANCE_TERMS.map((term) => term.name);

/** one backup, and what the rest of the season did with him */
export interface RoleExample {
  cut: ContingentCut;
  /** he averaged a starter's snap share over the weeks he played after */
  becameStarter: boolean;
  /**
   * He averaged a starter's points over the weeks he played after, taken
   * at his position's own tier. Half the snaps is a bar a second receiver
   * clears by turning up, so a fit taught on it finds role changes a
   * league has no use for.
   */
  scoredLikeStarter: boolean;
}

/** which of the two things a fit is asked to predict */
export type RoleOutcome = "half the snaps" | "a starter's points";

const OUTCOME_OF: Record<RoleOutcome, (one: RoleExample) => boolean> = {
  "half the snaps": (one) => one.becameStarter,
  "a starter's points": (one) => one.scoredLikeStarter,
};

export const ROLE_OUTCOMES = Object.keys(OUTCOME_OF) as RoleOutcome[];

export interface RoleChanceFit {
  outcome: RoleOutcome;
  trainedOn: number[];
  examples: number;
  /** how many of them the outcome came true for */
  opened: number;
  means: number[];
  deviations: number[];
  /** the intercept, then one weight per term in `roleChanceTermNames` order */
  weights: number[];
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

/** the raw value of every term, in `roleChanceTermNames` order */
export const chanceTermValues = (cut: ContingentCut): number[] =>
  CHANCE_TERMS.map((term) => term.of(cut));

function standardized(
  fit: Pick<RoleChanceFit, "means" | "deviations">, cut: ContingentCut,
): number[] {
  const raw = chanceTermValues(cut);

  return [1, ...raw.map((value, i) =>
    (value - (fit.means[i] ?? 0)) / (fit.deviations[i] ?? 1))];
}

/**
 * The same pull the sleeper fit uses, as a share of the rows behind it,
 * so a fit on one season is shrunk the same amount as a fit on seven.
 */
export const LAMBDA_SHARE = 0.01;

/**
 * A ridge on a nought or one answers with a number that can sit outside
 * nought and one, so it is squeezed back in. The floor is not zero
 * because every backup has some chance, and a score multiplied by a hard
 * zero would throw the first part away entirely.
 */
const LOWEST_CHANCE = 0.02;
const HIGHEST_CHANCE = 0.95;

export function fitRoleChance(
  examples: RoleExample[], options: RoleChanceOptions = {},
): RoleChanceFit {
  const outcome = options.outcome ?? "half the snaps";
  const lambdaShare = options.lambdaShare ?? LAMBDA_SHARE;
  const happened = OUTCOME_OF[outcome];

  if (examples.length <= CHANCE_TERMS.length) {
    throw new Error(
      `a role chance fit wants more than ${CHANCE_TERMS.length} rows and ` +
        `has ${examples.length}`,
    );
  }

  const raw = examples.map((one) => chanceTermValues(one.cut));
  const means = CHANCE_TERMS.map((_, i) => mean(raw.map((row) => row[i] ?? 0)));
  const scaling = {
    means,
    deviations: CHANCE_TERMS.map((_, i) =>
      deviation(raw.map((row) => row[i] ?? 0), means[i] ?? 0)),
  };
  const X = examples.map((one) => standardized(scaling, one.cut));
  const y = examples.map((one) => (happened(one) ? 1 : 0));

  return {
    ...scaling,
    outcome,
    trainedOn: [...new Set(examples.map((one) => one.cut.season))]
      .sort((a, b) => a - b),
    examples: examples.length,
    opened: examples.filter(happened).length,
    weights: fitRidge(X, y, Math.max(1e-6, lambdaShare * examples.length)),
  };
}

/**
 * The share of the snaps past which a backup is playing enough that his
 * own share swamps anything a fit could learn about the man in front of
 * him. A fit given this ceiling has to answer off the incumbent, which
 * is the only way to find out whether the incumbent says anything.
 */
export const BENCH_SNAP_CEILING = 0.30;

export interface RoleChanceOptions {
  lambdaShare?: number;
  /** the snap share a row is dropped at, one by default, meaning none */
  snapCeiling?: number;
  /** what the fit predicts, half the snaps by default */
  outcome?: RoleOutcome;
}

/**
 * The fit a reader could have had at the end of a week of `season`. The
 * rows from that season and later are dropped here rather than by the
 * caller, so a bench cannot peek by forgetting to cut them.
 */
export function fitRoleChanceAsOf(
  season: number, examples: RoleExample[], options: RoleChanceOptions = {},
): RoleChanceFit {
  const ceiling = options.snapCeiling ?? 1;

  return fitRoleChance(
    examples.filter((one) =>
      one.cut.season < season && one.cut.snapShare < ceiling),
    options,
  );
}

export function roleChance(fit: RoleChanceFit, cut: ContingentCut): number {
  return clamp(
    predictRidge(fit.weights, standardized(fit, cut)),
    LOWEST_CHANCE,
    HIGHEST_CHANCE,
  );
}

/* ---------- the two parts together ---------- */

export interface ContingentScore {
  season: number;
  week: number;
  playerId: string;
  playerName: string;
  position: string;
  price: number;
  drafted: boolean;
  /** what he would average a game with the job in front of him */
  wouldAverage: number;
  /** the chance that job comes free before the season ends */
  roleChance: number;
  /** what a player bought at his price averages */
  pricePpg: number;
  /** the chance times what taking the job would be worth over his price */
  score: number;
}

export function scoreContingent(
  fit: RoleChanceFit, cut: ContingentCut,
): ContingentScore {
  const would = wouldAverage(cut);
  const chance = roleChance(fit, cut);

  return {
    season: cut.season,
    week: cut.week,
    playerId: cut.playerId,
    playerName: cut.playerName,
    position: cut.position,
    price: cut.price,
    drafted: cut.drafted,
    wouldAverage: would,
    roleChance: chance,
    pricePpg: cut.priceMedian,
    score: chance * (would - cut.priceMedian),
  };
}

/** what taking the job would be worth over what his price already pays */
export const jobValue = (score: ContingentScore): number =>
  score.wouldAverage - score.pricePpg;

/**
 * A number in nought and one that rises with what it is given, so adding
 * it to a whole number can only settle players the whole number ties.
 */
const asTiebreak = (value: number): number =>
  0.5 + Math.atan(value) / Math.PI;

/**
 * Rank on the chance, and let the value settle the players the chance
 * cannot tell apart. Chances are cut into bands of `band` and every
 * player in a band is ordered on what the job would be worth to him. Two
 * players either side of a band edge stay in chance order however close
 * they are, which is what a rule has to give up to answer the same way
 * whatever order the players arrive in.
 */
export const chanceThenValue = (
  band: number, score: ContingentScore,
): number => Math.floor(score.roleChance / band) + asTiebreak(jobValue(score));

/** the same the other way round: the value leads and the chance settles it */
export const valueThenChance = (
  band: number, score: ContingentScore,
): number =>
  Math.floor(jobValue(score) / band) + asTiebreak(score.roleChance);

/** every player scored, the biggest contingent claim first */
export function rankContingent(
  fit: RoleChanceFit, cuts: ContingentCut[],
): ContingentScore[] {
  return cuts
    .map((cut) => scoreContingent(fit, cut))
    .sort((a, b) => b.score - a.score);
}

/* ---------- whether the chance means what it says ---------- */

/** one player, what he was given and whether it came true */
export interface Marked {
  chance: number;
  happened: boolean;
}

/** one decile of the chance, with what it promised and what happened */
export interface CalibrationBin {
  /** the lowest and highest chance that landed in this decile */
  low: number;
  high: number;
  players: number;
  /** what the fit said on average, and how often it actually happened */
  predicted: number;
  realized: number;
}

/**
 * Deciles of the predicted chance rather than fixed width bands, because
 * most backups sit under a fifth and fixed bands would leave the top
 * three empty.
 */
export function calibration(
  marked: Marked[], bins = 10,
): CalibrationBin[] {
  const sorted = [...marked].sort((a, b) => a.chance - b.chance);
  const out: CalibrationBin[] = [];

  for (let bin = 0; bin < bins; bin++) {
    const from = Math.floor((bin * sorted.length) / bins);
    const to = Math.floor(((bin + 1) * sorted.length) / bins);
    const mine = sorted.slice(from, to);

    if (mine.length === 0) {
      continue;
    }

    out.push({
      low: mine[0]!.chance,
      high: mine[mine.length - 1]!.chance,
      players: mine.length,
      predicted: mean(mine.map((one) => one.chance)),
      realized: mean(mine.map((one) => (one.happened ? 1 : 0))),
    });
  }

  return out;
}

/**
 * What each term weighs, with what it averaged over the rows behind it.
 * A weight of nothing on a term that averages nothing is a term the file
 * did not fill in, which is a different problem from one that is filled
 * in and says nothing.
 */
export const roleChanceWeights = (
  fit: RoleChanceFit,
): { term: string; weight: number; average: number }[] =>
  roleChanceTermNames.map((term, i) => ({
    term,
    weight: fit.weights[i + 1] ?? 0,
    average: fit.means[i] ?? 0,
  }));
