/**
 * What an offence is worth, carried forward week by week.
 *
 * Before a season starts all we have is a prior. Each Sunday adds one
 * observation, and the belief going into the next week is the old
 * belief and the new result weighed by how sure we were of each. A
 * team that has looked good for ten weeks moves less on an eleventh
 * than one we have only just met.
 *
 * The betting total is kept separate on purpose. It says what this
 * particular game should look like, and the state says what the
 * offence is worth in general, so a shootout does not get mistaken for
 * a team improving.
 */

export interface TeamBelief {
  /** points a game above or below the league's offence */
  mean: number;
  /** how unsure we are of that, as a variance */
  variance: number;
}

export interface TeamStateSettings {
  /** what an average offence's skill players score in a week */
  leagueMean: number;
  /** how far an offence wanders in a week */
  drift: number;
  /** how noisy one afternoon is */
  weekNoise: number;
  /** how unsure we are before a ball is thrown */
  priorVariance: number;
  /** points added per point the game total runs above average */
  perTotalPoint: number;
  /** the total a neutral game is expected to reach */
  neutralTotal: number;
}

/**
 * Fitted on 2021 to 2024 and left alone for 2025. `weekNoise` is large
 * next to `drift` because one afternoon says much less about an
 * offence than a season does.
 */
export const TEAM_DEFAULTS: TeamStateSettings = {
  leagueMean: 45.3,
  drift: 1.2,
  weekNoise: 190,
  priorVariance: 40,
  perTotalPoint: 0.9,
  neutralTotal: 45,
};

export const unknownTeam = (settings = TEAM_DEFAULTS): TeamBelief =>
  ({ mean: 0, variance: settings.priorVariance });

/** what this offence should score in this particular game */
export function expectTeamWeek(
  belief: TeamBelief,
  gameTotal: number,
  settings = TEAM_DEFAULTS,
): number {
  return Math.max(
    5,
    settings.leagueMean +
      belief.mean +
      (gameTotal - settings.neutralTotal) * settings.perTotalPoint,
  );
}

/**
 * A week happens. What we expected is compared with what came of it,
 * and the belief moves by the share of the gap that belongs to the
 * offence rather than to the afternoon.
 */
export function afterTeamWeek(
  belief: TeamBelief,
  scored: number,
  gameTotal: number,
  settings = TEAM_DEFAULTS,
): TeamBelief {
  const wandered = belief.variance + settings.drift;
  const surprise = scored - expectTeamWeek(belief, gameTotal, settings);
  // how much of the surprise to keep: all of it if we knew nothing,
  // almost none if we have watched them for months
  const keep = wandered / (wandered + settings.weekNoise);

  return {
    mean: belief.mean + keep * surprise,
    variance: wandered * (1 - keep),
  };
}

/** the belief a new season starts from, given last season's */
export function carryToNextSeason(
  belief: TeamBelief,
  settings = TEAM_DEFAULTS,
): TeamBelief {
  return {
    // an offence is not the same one it was in January
    mean: belief.mean * 0.55,
    variance: Math.min(settings.priorVariance, belief.variance + 22),
  };
}
