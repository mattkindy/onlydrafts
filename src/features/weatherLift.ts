/**
 * What the day does to an offence, as a multiplier near one.
 *
 * Measured inside each side's own season, so its cold afternoons stand
 * against its own mild ones and the side, its coach and its passer are
 * held still. Thirty degrees below mild costs a side 1.18 points and
 * fifteen miles an hour of wind costs 1.63, against an average of 21.4.
 *
 * A closed roof is a mild still afternoon, which is what it is.
 */

export interface Day {
  indoors: boolean;
  temperature?: number;
  wind?: number;
}

/** an afternoon nobody would call weather */
const MILD = 60;
const STILL = 5;
const A_SIDE_SCORES = 21.4;

/** points a side loses to thirty degrees of cold and to fifteen of wind */
const COLD_COSTS = 1.18;
const WIND_COSTS = 1.63;

export function weatherLift(day: Day): number {
  if (day.indoors) {
    return 1;
  }

  const cold = Math.max(0, MILD - (day.temperature ?? MILD)) / 30;
  const blowing = Math.max(0, (day.wind ?? STILL) - STILL) / 15;
  const lost = COLD_COSTS * cold + WIND_COSTS * blowing;

  // a floor, since no afternoon takes half a side's offence away
  return Math.max(0.75, 1 - lost / A_SIDE_SCORES);
}
