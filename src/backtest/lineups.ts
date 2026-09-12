/**
 * Random legal lineups paired off, and what their draws said about who
 * would win.
 *
 * A league's own matchups are too few to calibrate anything on, so the
 * bench draws seven man lineups out of the week's pool and pairs them.
 * Each pair gives one Brier point and one implied against realised
 * spread, which is what says whether a set of draws is too confident.
 */

/**
 * How often one side's draws beat the other's. The app's own winChance
 * is this, and a caller hands it in rather than have src reach into the
 * pages.
 */
export type Chance = (mine: number[], theirs: number[]) => number;

/** the seats a lineup fills, and what the flex will take */
const SEATS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX"];
const FLEX = ["RB", "WR", "TE"];

/** all a man needs to be seated */
export interface Seated {
  key: string;
  position: string;
}

/**
 * One legal lineup, or nothing when the pools cannot fill it without
 * playing somebody twice.
 */
export function lineupFrom<T extends Seated>(
  pools: Map<string, T[]>, rand: () => number,
): T[] | null {
  const taken = new Set<string>();
  const out: T[] = [];

  for (const seat of SEATS) {
    const want = seat === "FLEX" ? FLEX[Math.floor(rand() * 3)]! : seat;
    const pool = pools.get(want) ?? [];

    if (!pool.length) {
      return null;
    }

    let tries = 0;
    let man = pool[Math.floor(rand() * pool.length)]!;

    while (taken.has(man.key) && tries < 20) {
      man = pool[Math.floor(rand() * pool.length)]!;
      tries++;
    }

    if (taken.has(man.key)) {
      return null;
    }

    taken.add(man.key);
    out.push(man);
  }

  return out;
}

export interface Tally {
  buckets: { won: number; count: number; predicted: number }[];
  brier: number;
  logLoss: number;
  pairs: number;
  impliedSide: number;
  realizedSide: number;
  sides: number;
  impliedDiff: number;
  realizedDiff: number;
  /** how far a side's projected total sat from what it scored */
  sideError: number;
  /** predicted and realized win rate by how big the projected edge is */
  edges: { predicted: number; won: number; count: number }[];
}

export const BUCKETS = 10;
export const EDGES = [0, 5, 10, 15, 20, 25];

export const emptyTally = (): Tally => ({
  buckets: Array.from({ length: BUCKETS }, () =>
    ({ won: 0, count: 0, predicted: 0 })),
  brier: 0,
  logLoss: 0,
  pairs: 0,
  impliedSide: 0,
  realizedSide: 0,
  sides: 0,
  impliedDiff: 0,
  realizedDiff: 0,
  sideError: 0,
  edges: EDGES.map(() => ({ predicted: 0, won: 0, count: 0 })),
});

const mean = (its: number[]) => its.reduce((s, n) => s + n, 0) / its.length;

function variance(its: number[]): number {
  const middle = mean(its);

  return mean(its.map((n) => (n - middle) * (n - middle)));
}

const edgeOf = (margin: number) => {
  let at = 0;

  while (at < EDGES.length - 1 && margin >= EDGES[at + 1]!) {
    at++;
  }

  return at;
};

/** one paired matchup added to a tally */
export function record(
  tally: Tally,
  mine: number[],
  theirs: number[],
  myActual: number,
  theirActual: number,
  chance: Chance,
): void {
  const raw = chance(mine, theirs);
  const iWin = myActual > theirActual;
  const favoured = raw >= 0.5;
  const p = favoured ? raw : 1 - raw;
  const won = favoured === iWin ? 1 : 0;
  const at = Math.min(BUCKETS - 1, Math.max(0, Math.floor((p - 0.5) / 0.05)));

  tally.buckets[at]!.count++;
  tally.buckets[at]!.won += won;
  tally.buckets[at]!.predicted += p;
  tally.brier += (p - won) * (p - won);
  tally.logLoss -= Math.log(Math.max(1e-9, won ? p : 1 - p));
  tally.pairs++;

  const myMean = mean(mine);
  const theirMean = mean(theirs);

  tally.impliedSide += variance(mine) + variance(theirs);
  tally.realizedSide += (myActual - myMean) * (myActual - myMean) +
    (theirActual - theirMean) * (theirActual - theirMean);
  tally.sides += 2;
  tally.sideError +=
    Math.abs(myActual - myMean) + Math.abs(theirActual - theirMean);

  const diff = mine.map((n, i) => n - theirs[i]!);
  const actualDiff = myActual - theirActual;
  const meanDiff = myMean - theirMean;

  tally.impliedDiff += variance(diff);
  tally.realizedDiff += (actualDiff - meanDiff) * (actualDiff - meanDiff);

  const edge = tally.edges[edgeOf(Math.abs(meanDiff))]!;
  edge.predicted += p;
  edge.won += won;
  edge.count++;
}

/** two tallies added, so shares of a run can be pooled */
export function addTally(into: Tally, more: Tally): void {
  into.brier += more.brier;
  into.logLoss += more.logLoss;
  into.pairs += more.pairs;
  into.impliedSide += more.impliedSide;
  into.realizedSide += more.realizedSide;
  into.sides += more.sides;
  into.impliedDiff += more.impliedDiff;
  into.realizedDiff += more.realizedDiff;
  into.sideError += more.sideError;

  more.buckets.forEach((one, at) => {
    into.buckets[at]!.won += one.won;
    into.buckets[at]!.count += one.count;
    into.buckets[at]!.predicted += one.predicted;
  });
  more.edges.forEach((one, at) => {
    into.edges[at]!.predicted += one.predicted;
    into.edges[at]!.won += one.won;
    into.edges[at]!.count += one.count;
  });
}
