/**
 * Splitting a game to game swing into the coin flips inside one game
 * and the swing of the game itself.
 *
 * A quantity the walk draws once a snap can only wander as far as the
 * draws let it. Reality moves as a block: a game plan, a matchup, a
 * blowout or a knock at halftime shifts a whole afternoon at once.
 *
 * Both estimators are the one-way random effects split. The within
 * part is what independent draws would give, the total is what the
 * games did, and the leftover is the game itself. That leftover comes
 * out negative on thin samples, so it is floored at zero.
 */

export const middle = (values: number[]): number =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

export const varianceOf = (values: number[]): number => {
  const mid = middle(values);

  return middle(values.map((v) => (v - mid) ** 2));
};

export const spreadOf = (values: number[]): number => Math.sqrt(varianceOf(values));

export interface Split {
  /** how far the per-game number moves, all in */
  total: number;
  /** the part independent draws inside one game would have given */
  flips: number;
  /** and the part left for the game itself */
  gameLevel: number;
}

const finish = (total: number, flips: number): Split => ({
  total: Math.sqrt(total),
  flips: Math.sqrt(flips),
  gameLevel: Math.sqrt(Math.max(0, total - flips)),
});

/** one game of a rate: how many chances there were and how many came off */
export interface Tally {
  tries: number;
  hits: number;
}

/**
 * A rate drawn `tries` times a game. A side hitting at p over n tries
 * lands within sqrt(p(1-p)/n) of it by luck alone, so that much is
 * taken off before the leftover is called a swing in the rate itself.
 */
export function rateSplit(games: Tally[]): Split | undefined {
  const usable = games.filter((g) => g.tries > 0);

  if (usable.length < 4) {
    return undefined;
  }

  const rates = usable.map((g) => g.hits / g.tries);
  const pooled = usable.reduce((a, g) => a + g.hits, 0) /
    usable.reduce((a, g) => a + g.tries, 0);
  const flips = middle(usable.map((g) => (pooled * (1 - pooled)) / g.tries));

  return finish(varianceOf(rates), flips);
}

/**
 * An average of draws, where each game is the mean of however many it
 * got. The within-game variance is pooled across games and then
 * divided by each game's own count, since a game of four touches is
 * far freer to wander than one of twenty.
 */
export function meanSplit(games: number[][]): Split | undefined {
  const usable = games.filter((g) => g.length > 0);

  if (usable.length < 4) {
    return undefined;
  }

  const spare = usable.reduce((a, g) => a + g.length - 1, 0);

  if (spare <= 0) {
    return undefined;
  }

  const within = usable.reduce((a, g) => {
    const mid = middle(g);

    return a + g.reduce((b, v) => b + (v - mid) ** 2, 0);
  }, 0) / spare;
  const flips = middle(usable.map((g) => within / g.length));

  return finish(varianceOf(usable.map(middle)), flips);
}

/**
 * The mean of a set of splits, so many men or many sides read as one
 * row. Averaged as spreads rather than as variances, to match how the
 * per-man numbers are quoted everywhere else.
 */
export function poolSplits(splits: Split[]): Split {
  return {
    total: middle(splits.map((s) => s.total)),
    flips: middle(splits.map((s) => s.flips)),
    gameLevel: middle(splits.map((s) => s.gameLevel)),
  };
}
