/**
 * Once a season is running there are two views of a player: what we
 * projected before it started, and what he has actually done. Neither
 * wins outright. Mixing them beats both at every point in the season,
 * and by the widest margin in September.
 *
 * The weights below were fitted by rolling backtest over 2023 to 2025,
 * measured by rank correlation against what each player went on to
 * average over his remaining games. Even in December the preseason
 * projection still gets about 15%, because a dozen games is a small
 * sample and a hot stretch is partly luck.
 */

/** fitted weight on season-to-date, by games the player has played */
const FITTED: [games: number, weight: number][] = [
  [2, 0.4],
  [4, 0.5],
  [6, 0.55],
  [8, 0.7],
  [10, 0.8],
  [12, 0.85],
];

/** how much a player's season so far should outweigh his projection */
export function toDateWeight(games: number): number {
  if (games <= 0) {
    return 0;
  }

  const first = FITTED[0]!;

  if (games <= first[0]) {
    // one game is half the evidence of two, so ease in from nothing
    return (first[1] * games) / first[0];
  }

  for (let i = 1; i < FITTED.length; i++) {
    const [priorGames, priorWeight] = FITTED[i - 1]!;
    const [nextGames, nextWeight] = FITTED[i]!;

    if (games <= nextGames) {
      const along = (games - priorGames) / (nextGames - priorGames);
      return priorWeight + along * (nextWeight - priorWeight);
    }
  }

  return FITTED[FITTED.length - 1]![1];
}

export interface RestOfSeasonInput {
  /** points a game we expected before the season started */
  preseason: number;
  /** points a game he has actually averaged */
  toDate: number;
  /** games he has played */
  games: number;
}

/** points a game to expect over his remaining games */
export function projectRest(input: RestOfSeasonInput): number {
  const weight = toDateWeight(input.games);
  return (1 - weight) * input.preseason + weight * input.toDate;
}
