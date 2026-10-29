/**
 * A defence's level for the rest of the season, once some of it has
 * been played.
 *
 * The board's defence used to be last season and nothing else: the
 * sacks and takeaways of the players on the roster now, and the points
 * the club gave up. That number never moved, so a defence that had
 * collapsed or arrived by October was priced on the waiver page as if
 * it were still last year.
 *
 * Two things fix it, and `scripts/defenceSeasonEval.ts` measured both
 * over 2017 to 2025. Last season is pulled half way to the league's
 * average, since a defence's year is mostly noise and the best and
 * worst of them come back toward the middle. Then this season's games
 * take a share that grows with how many have been played, reaching
 * half at seventeen games. Picked on 2017 to 2021 and marked on 2022 to
 * 2025, that cut the error on the rest of the season from 1.86 to 1.51
 * points a game after week 3 and from 2.25 to 1.93 after week 10, and
 * ordered the defences better at every cut.
 *
 * Every part is a rate a game, the counting parts and the chance of each
 * points-allowed bracket alike. A league pays them in a straight line, so
 * blending the parts is blending what any ladder pays for them.
 */

export type DefenceParts = Record<string, number>;

/** how far last season is pulled toward the league's average */
export const TOWARD_THE_MIDDLE = 0.5;

/** the games of this season it takes for them to carry half the weight */
export const SEASON_HALF_GAMES = 17;

/** the average defence's parts, over every defence given */
export function leagueParts(defences: DefenceParts[]): DefenceParts {
  const out: DefenceParts = {};

  for (const one of defences) {
    for (const [part, n] of Object.entries(one)) {
      out[part] = (out[part] ?? 0) + n / defences.length;
    }
  }

  return out;
}

/**
 * The level from last season, the league's average and this season so
 * far. `games` is how many of its own games this season stands on, and
 * with none the level is last season pulled toward the middle.
 */
export function defenceLevel(
  last: DefenceParts, league: DefenceParts,
  thisSeason: DefenceParts, games: number,
): DefenceParts {
  const onSeason = games / (games + SEASON_HALF_GAMES);
  const parts = new Set([
    ...Object.keys(last), ...Object.keys(league), ...Object.keys(thisSeason),
  ]);
  const out: DefenceParts = {};

  for (const part of parts) {
    const prior = (1 - TOWARD_THE_MIDDLE) * (last[part] ?? 0) +
      TOWARD_THE_MIDDLE * (league[part] ?? 0);

    out[part] = (1 - onSeason) * prior + onSeason * (thisSeason[part] ?? 0);
  }

  return out;
}
