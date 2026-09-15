/**
 * What a draft price says about how a player actually finishes.
 *
 * A projection ranks players by the points it expects. This fits the
 * price instead: for a position and an average draft position, it says
 * what players bought there went on to average, how wide that ran, and
 * how often one of them finished as a startable player.
 *
 * The spread is counted off the players rather than taken from a
 * standard deviation, because it widens as the price falls: the 10th to
 * the 90th percentile is two thirds of the median in the first round and
 * one and a half times it after pick 96. Every curve is monotone in
 * price, and the seasons from the one you ask about onward stay shut.
 */

import { loadAdp, type AdpEntry, type AdpFormat } from "../data/adp.js";
import { loadPlayerStats, loadWeeklyRosters } from "../data/nflverse.js";
import { normalizeName } from "../data/names.js";
import { presets, type ScoringRules } from "../scoring/fantasyPoints.js";
import { summarizeSeason } from "./seasonSummary.js";

/** the positions a draft board and the stat files agree on */
export const PRICED_POSITIONS = ["QB", "RB", "WR", "TE"];

/**
 * How many at each position finish inside the tier a league starts every
 * week. Ranked on the season's total points, so a player who missed six
 * games has to have been that much better in the games he played.
 */
export const STARTER_TIER: Record<string, number> = {
  QB: 12,
  RB: 24,
  WR: 24,
  TE: 12,
};

/** below this nobody counts as having had a season at all */
export const MIN_TIER_GAMES = 6;

/** the first August with a draft board on disk */
export const FIRST_PRICED_SEASON = 2015;

/** one or two seasons of prices fit a curve that says nothing */
const MIN_TRAIN_SEASONS = 3;

/** a position with fewer rows than this reads off the pooled curve */
const MIN_POSITION_ROWS = 60;

/**
 * How many neighbouring prices each point on the curve counts, as a
 * share of the position's rows and as a floor. Only two or three tight
 * ends a year go in the first four rounds, so any window wide enough to
 * read a 90th percentile off reaches down to the tenth tight end. A
 * neighbour is weighted by how far away in price he is, which keeps the
 * count up without letting the far end of the window set the answer.
 */
const WINDOW_SHARE = 0.1;
const MIN_WINDOW = 45;

/** the prices the curve is evaluated at, log spaced because the board is */
const KNOTS = 24;
const CHEAPEST_PRICE = 260;

export interface PriceQuantiles {
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

const QUANTILE_LEVELS: Record<keyof PriceQuantiles, number> = {
  p10: 0.1,
  p25: 0.25,
  p50: 0.5,
  p75: 0.75,
  p90: 0.9,
};

const QUANTILE_KEYS = Object.keys(QUANTILE_LEVELS) as (keyof PriceQuantiles)[];

/** how much the drafters disagreed about one player, where the board says */
export interface DrafterSpread {
  /** how far his pick moved across the sampled drafts */
  stdev: number;
  /** his cut of those drafts, which compares across seasons of different size */
  draftedShare: number;
}

/** one player, what he cost, and what the buyer got */
export interface PriceOutcome {
  season: number;
  playerName: string;
  position: string;
  adp: number;
  /** PPR points a game over the games he played, zero if he played none */
  ppg: number;
  games: number;
  /** he finished inside his position's starter tier */
  hit: boolean;
  spread?: DrafterSpread;
}

/** how many players and seasons are behind a number at one price */
export interface PriceSupport {
  players: number;
  seasons: number;
  /**
   * The same count once the distance weighting is taken off, so a window
   * whose far end barely counts does not claim the players in it.
   */
  effectivePlayers: number;
  /** the prices the window actually spans */
  lowestAdp: number;
  highestAdp: number;
}

/** which of the two fits gives the mean */
export type PriceFit = "windowed" | "logLinear";

/**
 * The windowed fit ships, and the probe cannot separate the two. Scored
 * on each season in turn against a curve fitted only on the seasons
 * before it, both come out at 3.78 points of error, and each orders
 * players better in four of the eight seasons. What decides it is that
 * the quantiles and the hit rate come off the same window, so one thing
 * is fitted rather than two: a straight line on log price says nothing
 * about the spread and would need the window beside it anyway.
 */
export const SHIPPED_FIT: PriceFit = "windowed";

export type DisagreementMeasure = "spread" | "drafted";

/** one third of the players at a price, cut by how much the room argued */
export interface DisagreementTercile {
  measure: DisagreementMeasure;
  /** 0 is the narrowest spread, or the fewest drafts that took him */
  tercile: number;
  players: number;
  /**
   * Where these players landed among the players who cost what they
   * cost, averaged. Half means the disagreement told you nothing.
   */
  meanPlace: number;
  /** how often one of them beat the 90th percentile for his price */
  aboveP90: number;
  hitRate: number;
  /**
   * Where these players' own prices sat in their windows, averaged. Near
   * half means the thirds are level on price, which is the whole claim
   * the rest of the row depends on.
   */
  meanPricePlace: number;
}

export interface DisagreementFinding {
  terciles: DisagreementTercile[];
  /**
   * The top tercile against the bottom tercile, in standard errors of
   * the difference. Positive means the players the room argued about
   * more often beat their price.
   */
  tailZ: Record<DisagreementMeasure, number>;
  hitZ: Record<DisagreementMeasure, number>;
  /** either measure moving that thing by two standard errors or more */
  movesTheTail: boolean;
  movesTheHitRate: boolean;
}

export interface MarketPrice {
  /** the seasons every number here was counted from */
  trainedOn: number[];
  /** mean PPR points a game for a player at this price */
  expectedPpg(position: string, adp: number): number;
  /** where players at this price landed, so the right tail is visible */
  quantiles(position: string, adp: number): PriceQuantiles;
  /** the chance of finishing inside the starter tier */
  hitRate(position: string, adp: number): number;
  support(position: string, adp: number): PriceSupport;
  disagreement: DisagreementFinding;
}

export interface MarketPriceOptions {
  /** which draft room's prices to read; a PPR room takes receivers earlier */
  format?: AdpFormat;
  /** the earliest season to learn from */
  from?: number;
  /** what the outcome is scored under, PPR unless a caller says otherwise */
  rules?: ScoringRules;
  fit?: PriceFit;
  /**
   * Seasons already counted, keyed by season. A bench fitting one curve
   * per season reads every earlier season again for each of them, which
   * is a season of stat files loaded ten times over. Hand in a map and
   * each one is read once. The map belongs to one set of the options
   * above, since nothing in it says which format or rules it was counted
   * under.
   */
  counted?: Map<number, SeasonPrices | null>;
}

/* ---------- one season's prices against what happened ---------- */

export interface SeasonPrices {
  season: number;
  rows: PriceOutcome[];
  /** on a roster but never in a stat line, kept at zero points a game */
  neverPlayed: number;
  /** board names that matched nobody on any roster, so they are left out */
  unmatched: number;
}

interface Finished {
  position: string;
  games: number;
  ppg: number;
  total: number;
}

/**
 * The boards have no player ids, so the join is on a normalized name,
 * and two players can share one name. The board says which position it
 * priced, so prefer the player who plays it and fall back to whoever
 * played the most.
 */
function pickFinished(
  candidates: Finished[],
  position: string,
): Finished | undefined {
  const atPosition = candidates.filter((one) => one.position === position);
  const pool = atPosition.length > 0 ? atPosition : candidates;

  return [...pool].sort((a, b) => b.games - a.games)[0];
}

/** the season total the last man in the starter tier put up */
function starterTierCut(finished: Finished[], position: string): number {
  const tier = STARTER_TIER[position];

  if (tier === undefined) {
    return Infinity;
  }

  const eligible = finished
    .filter((one) => one.position === position && one.games >= MIN_TIER_GAMES)
    .sort((a, b) => b.total - a.total);

  return eligible[tier - 1]?.total ?? -Infinity;
}

function spreadOf(entry: AdpEntry): DrafterSpread | undefined {
  if (entry.stdev === undefined || entry.draftedShare === undefined) {
    return undefined;
  }

  return { stdev: entry.stdev, draftedShare: entry.draftedShare };
}

/**
 * What every player on one August's board went on to do. A player who
 * was drafted and never played is kept at zero points a game, because he
 * is the pick somebody spent, and dropping him would make every price
 * look better than it was.
 */
export async function seasonPrices(
  season: number,
  options: MarketPriceOptions = {},
): Promise<SeasonPrices> {
  const rules = options.rules ?? presets.ppr;
  const board = await loadAdp(season, options.format ?? "ppr");
  const summaries = summarizeSeason(await loadPlayerStats(season), rules);

  const finished = new Map<string, Finished[]>();
  const everyone: Finished[] = [];

  for (const summary of summaries.values()) {
    const one: Finished = {
      position: summary.position,
      games: summary.games,
      ppg: summary.pointsPerGame,
      total: summary.pointsPerGame * summary.games,
    };
    everyone.push(one);
    const key = normalizeName(summary.playerName);
    finished.set(key, [...(finished.get(key) ?? []), one]);
  }

  const onARoster = new Set<string>();

  for (const row of await loadWeeklyRosters(season)) {
    onARoster.add(normalizeName(row.name));
  }

  const cuts: Record<string, number> = {};

  for (const position of PRICED_POSITIONS) {
    cuts[position] = starterTierCut(everyone, position);
  }

  const rows: PriceOutcome[] = [];
  let neverPlayed = 0;
  let unmatched = 0;

  for (const entry of board.values()) {
    if (!PRICED_POSITIONS.includes(entry.position)) {
      continue;
    }

    const key = normalizeName(entry.name);
    const played = pickFinished(finished.get(key) ?? [], entry.position);

    if (!played && !onARoster.has(key)) {
      unmatched++;
      continue;
    }

    if (!played) {
      neverPlayed++;
    }

    const games = played?.games ?? 0;
    const total = played?.total ?? 0;

    rows.push({
      season,
      playerName: entry.name,
      position: entry.position,
      adp: entry.adp,
      ppg: played?.ppg ?? 0,
      games,
      hit: games >= MIN_TIER_GAMES && total >= (cuts[entry.position] ?? Infinity),
      spread: spreadOf(entry),
    });
  }

  return { season, rows, neverPlayed, unmatched };
}

/* ---------- the two fits ---------- */

const logPriceOf = (adp: number) => Math.log(Math.max(1, adp));

function knotPrices(): number[] {
  const cheapest = Math.log(CHEAPEST_PRICE);

  return Array.from({ length: KNOTS }, (_, i) => (i / (KNOTS - 1)) * cheapest);
}

/**
 * Pools neighbours that come out in the wrong order until nothing rises
 * with price, weighting each point by how many players are behind it.
 */
function madeDecreasing(values: number[], weights: number[]): number[] {
  const blocks: { sum: number; weight: number; count: number }[] = [];

  for (let i = 0; i < values.length; i++) {
    const weight = Math.max(1e-9, weights[i] ?? 1);
    blocks.push({ sum: (values[i] ?? 0) * weight, weight, count: 1 });

    while (blocks.length > 1) {
      const right = blocks[blocks.length - 1]!;
      const left = blocks[blocks.length - 2]!;

      if (left.sum / left.weight > right.sum / right.weight) {
        break;
      }

      blocks.pop();
      left.sum += right.sum;
      left.weight += right.weight;
      left.count += right.count;
    }
  }

  const out: number[] = [];

  for (const block of blocks) {
    const pooled = block.sum / block.weight;

    for (let i = 0; i < block.count; i++) {
      out.push(pooled);
    }
  }

  return out;
}

/** the `k` rows closest to `at` in log price, as a half-open range */
function windowAround(
  logPrices: number[],
  at: number,
  k: number,
): [number, number] {
  let low = 0;
  let high = logPrices.length;

  while (low < high) {
    const mid = (low + high) >> 1;

    if ((logPrices[mid] ?? 0) < at) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  let from = low;
  let to = low;
  const want = Math.min(k, logPrices.length);

  while (to - from < want) {
    const leftGap = from > 0 ? at - (logPrices[from - 1] ?? 0) : Infinity;
    const rightGap =
      to < logPrices.length ? (logPrices[to] ?? 0) - at : Infinity;

    if (leftGap <= rightGap) {
      from--;
    } else {
      to++;
    }
  }

  return [from, to];
}

const mean = (values: number[]) =>
  values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;

const total = (values: number[]) => values.reduce((sum, one) => sum + one, 0);

/** one value and how much it counts */
interface Weighted {
  value: number;
  weight: number;
}

const weightedMean = (points: Weighted[]) => {
  const weight = total(points.map((one) => one.weight));

  return weight <= 0
    ? 0
    : total(points.map((one) => one.value * one.weight)) / weight;
};

/**
 * The weighted percentile, each point counting as the middle of its own
 * slice of the weight so equal weights give back the ordinary one.
 */
function weightedQuantile(points: Weighted[], at: number): number {
  const weight = total(points.map((one) => one.weight));

  if (points.length === 0 || weight <= 0) {
    return 0;
  }

  const sorted = [...points].sort((a, b) => a.value - b.value);
  let before = 0;
  const places = sorted.map((one) => {
    const place = (before + one.weight / 2) / weight;
    before += one.weight;

    return { value: one.value, place };
  });

  if (at <= places[0]!.place) {
    return places[0]!.value;
  }

  for (let i = 1; i < places.length; i++) {
    const right = places[i]!;

    if (at > right.place) {
      continue;
    }

    const left = places[i - 1]!;
    const span = right.place - left.place;
    const frac = span <= 0 ? 0 : (at - left.place) / span;

    return left.value * (1 - frac) + right.value * frac;
  }

  return places[places.length - 1]!.value;
}

/** where `value` falls among `others`, ties counting half */
function placeAmong(others: Weighted[], value: number): number {
  const weight = total(others.map((one) => one.weight));

  if (weight <= 0) {
    return 0.5;
  }

  let below = 0;
  let level = 0;

  for (const other of others) {
    if (other.value < value) {
      below += other.weight;
    } else if (other.value === value) {
      level += other.weight;
    }
  }

  return (below + level / 2) / weight;
}

/** the rows near one price, each counting less the further off it is */
interface Neighbourhood {
  rows: PriceOutcome[];
  weights: number[];
  /** the count once the weighting is taken off */
  effective: number;
}

/**
 * A neighbour at the edge of the window counts for nothing and one at
 * the query price counts for everything, on the tricube curve loess
 * uses. Weighting them equally instead put the top tight end 2.6 points
 * under what those players really averaged, because the 45 rows a thin
 * position needs for a 90th percentile reach down to the tenth one.
 */
function neighboursOf(
  rows: PriceOutcome[],
  logPrices: number[],
  window: number,
  at: number,
  skip = -1,
): Neighbourhood {
  const [from, to] = windowAround(logPrices, at, window);
  const inside: PriceOutcome[] = [];
  const gaps: number[] = [];

  for (let i = from; i < to; i++) {
    if (i === skip) {
      continue;
    }

    inside.push(rows[i]!);
    gaps.push(Math.abs((logPrices[i] ?? 0) - at));
  }

  const widest = Math.max(1e-9, ...gaps);
  const weights = gaps.map((gap) => {
    const u = Math.min(1, gap / widest);

    return Math.max(1e-6, (1 - u ** 3) ** 3);
  });
  const summed = total(weights);

  return {
    rows: inside,
    weights,
    effective: summed <= 0 ? 0 : summed ** 2 / total(weights.map((w) => w * w)),
  };
}

const weighted = (
  near: Neighbourhood,
  valueOf: (row: PriceOutcome) => number,
): Weighted[] =>
  near.rows.map((row, i) => ({
    value: valueOf(row),
    weight: near.weights[i] ?? 0,
  }));

const emptyQuantiles = (): Record<keyof PriceQuantiles, number[]> => ({
  p10: [], p25: [], p50: [], p75: [], p90: [],
});

/** one position's rows, and what the curve reads at each knot */
interface PositionCurve {
  rows: PriceOutcome[];
  logPrices: number[];
  window: number;
  knots: number[];
  ppg: number[];
  hit: number[];
  quantiles: Record<keyof PriceQuantiles, number[]>;
}

function buildCurve(rows: PriceOutcome[]): PositionCurve {
  const sorted = [...rows].sort((a, b) => a.adp - b.adp);
  const logPrices = sorted.map((row) => logPriceOf(row.adp));
  const window = Math.max(MIN_WINDOW, Math.round(sorted.length * WINDOW_SHARE));
  const knots = knotPrices();

  const rawPpg: number[] = [];
  const rawHit: number[] = [];
  const weights: number[] = [];
  const rawQuantiles = emptyQuantiles();

  for (const knot of knots) {
    const near = neighboursOf(sorted, logPrices, window, knot);
    const points = weighted(near, (row) => row.ppg);

    rawPpg.push(weightedMean(points));
    rawHit.push(weightedMean(weighted(near, (row) => (row.hit ? 1 : 0))));
    weights.push(Math.max(1e-6, near.effective));

    for (const key of QUANTILE_KEYS) {
      rawQuantiles[key].push(weightedQuantile(points, QUANTILE_LEVELS[key]));
    }
  }

  const quantiles = emptyQuantiles();

  for (const key of QUANTILE_KEYS) {
    quantiles[key] = madeDecreasing(rawQuantiles[key], weights);
  }

  return {
    rows: sorted,
    logPrices,
    window,
    knots,
    ppg: madeDecreasing(rawPpg, weights),
    hit: madeDecreasing(rawHit, weights),
    quantiles,
  };
}

/** reads a knotted curve at one price, flat outside the knots */
function readCurve(
  curve: PositionCurve,
  values: number[],
  adp: number,
): number {
  const at = logPriceOf(adp);
  const knots = curve.knots;

  if (at <= (knots[0] ?? 0)) {
    return values[0] ?? 0;
  }

  for (let i = 1; i < knots.length; i++) {
    const right = knots[i] ?? 0;

    if (at > right) {
      continue;
    }

    const left = knots[i - 1] ?? 0;
    const frac = right === left ? 0 : (at - left) / (right - left);

    return (values[i - 1] ?? 0) * (1 - frac) + (values[i] ?? 0) * frac;
  }

  return values[values.length - 1] ?? 0;
}

/**
 * Points a game as a straight line on log price, one slope shared by
 * every position and an offset per position. The slope is kept at or
 * below zero so the line cannot say a later pick is worth more.
 */
interface LinearFit {
  slope: number;
  offsets: Record<string, number>;
  pooledOffset: number;
}

function groupByPosition(rows: PriceOutcome[]): Map<string, PriceOutcome[]> {
  const grouped = new Map<string, PriceOutcome[]>();

  for (const row of rows) {
    grouped.set(row.position, [...(grouped.get(row.position) ?? []), row]);
  }

  return grouped;
}

function fitLinear(rows: PriceOutcome[]): LinearFit {
  let crossProduct = 0;
  let spread = 0;

  for (const group of groupByPosition(rows).values()) {
    const meanX = mean(group.map((row) => logPriceOf(row.adp)));
    const meanY = mean(group.map((row) => row.ppg));

    for (const row of group) {
      const dx = logPriceOf(row.adp) - meanX;
      crossProduct += dx * (row.ppg - meanY);
      spread += dx * dx;
    }
  }

  const slope = spread === 0 ? 0 : Math.min(0, crossProduct / spread);
  const offsetFor = (group: PriceOutcome[]) =>
    mean(group.map((row) => row.ppg)) -
    slope * mean(group.map((row) => logPriceOf(row.adp)));
  const offsets: Record<string, number> = {};

  for (const [position, group] of groupByPosition(rows)) {
    offsets[position] = offsetFor(group);
  }

  return { slope, offsets, pooledOffset: offsetFor(rows) };
}

/* ---------- what the drafters' own disagreement adds ---------- */

/** the tail starts here, so a tenth of players clear it by construction */
const TAIL_LEVEL = 0.9;

const TERCILES = 3;

interface PlacedRow {
  hit: boolean;
  /** his place among the players who cost what he cost, 0 to 1 */
  place: number;
  /** his own price's place in that same window, which should be the middle */
  pricePlace: number;
  spreadPlace?: number;
  draftedPlace?: number;
}

const MEASURE_PLACE: Record<
  DisagreementMeasure,
  (row: PlacedRow) => number | undefined
> = {
  spread: (row) => row.spreadPlace,
  drafted: (row) => row.draftedPlace,
};

/**
 * Each player against the players who cost what he cost. Both sides of
 * the question need the price taken out of them first: a tenth rounder's
 * pick moves four rounds and a first rounder's moves four picks, so a
 * wide spread only means something next to the other players on that
 * shelf, and so does an outcome.
 */
function placeRows(curves: Map<string, PositionCurve>): PlacedRow[] {
  const placed: PlacedRow[] = [];

  for (const curve of curves.values()) {
    for (let i = 0; i < curve.rows.length; i++) {
      const row = curve.rows[i]!;
      const near = neighboursOf(
        curve.rows,
        curve.logPrices,
        curve.window,
        curve.logPrices[i]!,
        i,
      );
      const neighbourSpreads = (pick: (one: DrafterSpread) => number) =>
        weighted(near, (one) => (one.spread ? pick(one.spread) : NaN)).filter(
          (one) => !Number.isNaN(one.value),
        );

      placed.push({
        hit: row.hit,
        place: placeAmong(weighted(near, (one) => one.ppg), row.ppg),
        pricePlace: placeAmong(weighted(near, (one) => one.adp), row.adp),
        spreadPlace: row.spread
          ? placeAmong(
              neighbourSpreads((one) => one.stdev),
              row.spread.stdev,
            )
          : undefined,
        draftedPlace: row.spread
          ? placeAmong(
              neighbourSpreads((one) => one.draftedShare),
              row.spread.draftedShare,
            )
          : undefined,
      });
    }
  }

  return placed;
}

const tercileOf = (place: number) =>
  Math.min(TERCILES - 1, Math.floor(place * TERCILES));

/** two proportions apart, in standard errors of the difference */
function proportionZ(
  high: { hits: number; of: number },
  low: { hits: number; of: number },
): number {
  if (high.of === 0 || low.of === 0) {
    return 0;
  }

  const pooled = (high.hits + low.hits) / (high.of + low.of);
  const variance = pooled * (1 - pooled) * (1 / high.of + 1 / low.of);

  if (variance <= 0) {
    return 0;
  }

  return (high.hits / high.of - low.hits / low.of) / Math.sqrt(variance);
}

/** how many standard errors apart the ends of a cut are on one count */
const countsOf = (rows: PlacedRow[], counts: (row: PlacedRow) => boolean) => ({
  hits: rows.filter(counts).length,
  of: rows.length,
});

function measureDisagreement(placed: PlacedRow[]): DisagreementFinding {
  const terciles: DisagreementTercile[] = [];
  const tailZ: Record<DisagreementMeasure, number> = { spread: 0, drafted: 0 };
  const hitZ: Record<DisagreementMeasure, number> = { spread: 0, drafted: 0 };

  for (const measure of Object.keys(MEASURE_PLACE) as DisagreementMeasure[]) {
    const placeOf = MEASURE_PLACE[measure];
    const cut: PlacedRow[][] = Array.from({ length: TERCILES }, () => []);

    for (const row of placed) {
      const place = placeOf(row);

      if (place === undefined) {
        continue;
      }

      cut[tercileOf(place)]!.push(row);
    }

    for (let tercile = 0; tercile < TERCILES; tercile++) {
      const rows = cut[tercile]!;
      terciles.push({
        measure,
        tercile,
        players: rows.length,
        meanPlace: mean(rows.map((row) => row.place)),
        aboveP90: mean(rows.map((row) => (row.place > TAIL_LEVEL ? 1 : 0))),
        hitRate: mean(rows.map((row) => (row.hit ? 1 : 0))),
        meanPricePlace: mean(rows.map((row) => row.pricePlace)),
      });
    }

    const top = cut[TERCILES - 1]!;
    const bottom = cut[0]!;
    const inTail = (row: PlacedRow) => row.place > TAIL_LEVEL;
    const hit = (row: PlacedRow) => row.hit;
    tailZ[measure] = proportionZ(countsOf(top, inTail), countsOf(bottom, inTail));
    hitZ[measure] = proportionZ(countsOf(top, hit), countsOf(bottom, hit));
  }

  return {
    terciles,
    tailZ,
    hitZ,
    movesTheTail: Object.values(tailZ).some((z) => Math.abs(z) >= 2),
    movesTheHitRate: Object.values(hitZ).some((z) => Math.abs(z) >= 2),
  };
}

/* ---------- putting a curve together ---------- */

const MEAN_FROM: Record<
  PriceFit,
  (
    curveFor: (position: string) => PositionCurve,
    linear: LinearFit,
  ) => (position: string, adp: number) => number
> = {
  windowed: (curveFor) => (position, adp) => {
    const curve = curveFor(position);

    return readCurve(curve, curve.ppg, adp);
  },
  logLinear: (_curveFor, linear) => (position, adp) =>
    (linear.offsets[position] ?? linear.pooledOffset) +
    linear.slope * logPriceOf(adp),
};

/**
 * Fits the curve on rows somebody else counted. Take the loader below
 * unless you are testing, where handing in rows you made up is the only
 * way to know what the answer should be.
 */
export function fitMarketPrice(
  rows: PriceOutcome[],
  fit: PriceFit = SHIPPED_FIT,
): MarketPrice {
  if (rows.length === 0) {
    throw new Error("marketPrice needs at least one priced player");
  }

  const curves = new Map<string, PositionCurve>();

  for (const [position, group] of groupByPosition(rows)) {
    if (group.length < MIN_POSITION_ROWS) {
      continue;
    }

    curves.set(position, buildCurve(group));
  }

  const pooled = buildCurve(rows);
  const curveFor = (position: string) => curves.get(position) ?? pooled;
  const linear = fitLinear(rows);
  const placeable = curves.size > 0 ? curves : new Map([["pooled", pooled]]);

  return {
    trainedOn: [...new Set(rows.map((row) => row.season))].sort((a, b) => a - b),
    expectedPpg: MEAN_FROM[fit](curveFor, linear),
    quantiles: (position, adp) => {
      const curve = curveFor(position);
      const out: PriceQuantiles = { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 };

      for (const key of QUANTILE_KEYS) {
        out[key] = readCurve(curve, curve.quantiles[key], adp);
      }

      return out;
    },
    hitRate: (position, adp) => {
      const curve = curveFor(position);

      return Math.min(1, Math.max(0, readCurve(curve, curve.hit, adp)));
    },
    support: (position, adp) => {
      const curve = curveFor(position);
      const near = neighboursOf(
        curve.rows,
        curve.logPrices,
        curve.window,
        logPriceOf(adp),
      );

      return {
        players: near.rows.length,
        seasons: new Set(near.rows.map((row) => row.season)).size,
        effectivePlayers: near.effective,
        lowestAdp: near.rows[0]?.adp ?? 0,
        highestAdp: near.rows[near.rows.length - 1]?.adp ?? 0,
      };
    },
    disagreement: measureDisagreement(placeRows(placeable)),
  };
}

/**
 * The curve a drafter could have had in the August before `season`.
 *
 * Saying which season is the only way in, so a backtest cannot read the
 * season it is predicting: `season` and everything after it stays shut.
 */
export async function marketPriceAsOf(
  season: number,
  options: MarketPriceOptions = {},
): Promise<MarketPrice> {
  const from = options.from ?? FIRST_PRICED_SEASON;
  const rows: PriceOutcome[] = [];
  const counted: number[] = [];

  for (let earlier = from; earlier < season; earlier++) {
    const priced = options.counted?.has(earlier)
      ? options.counted.get(earlier) ?? null
      : await seasonPrices(earlier, options).catch(() => null);
    options.counted?.set(earlier, priced);

    if (!priced || priced.rows.length === 0) {
      continue;
    }

    rows.push(...priced.rows);
    counted.push(earlier);
  }

  if (counted.length < MIN_TRAIN_SEASONS) {
    throw new Error(
      `marketPrice for ${season} wants ${MIN_TRAIN_SEASONS} earlier ` +
        `seasons and has ${counted.length}`,
    );
  }

  return fitMarketPrice(rows, options.fit);
}
