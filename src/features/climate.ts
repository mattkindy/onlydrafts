/**
 * What the weather is likely to be at a ground on a given week.
 *
 * nflverse records the temperature after a game is played, so a season
 * being drafted for has none of it, and every outdoor fixture was
 * walked as a mild sixty degrees. Green Bay in December came out the
 * same as Miami in December.
 *
 * A ground's weather is where it is and what time of year it is, so
 * that is what this fits, with each ground's own history nudging the
 * answer. Each walk draws a day rather than taking an average, since a
 * mild December afternoon in Buffalo is a different game from a
 * freezing one.
 */

import { fitRidge, predictRidge } from "../backtest/ridge.js";

interface Where {
  latitude: number;
  /** the ground's longitude, which only a weather service asks for */
  longitude: number;
  /** grounds that close a roof, which take the weather out of it */
  indoors?: boolean;
}

/** home grounds, by the club that plays there */
export const HOME: Record<string, Where> = {
  ARI: { latitude: 33.53, longitude: -112.26, indoors: true },
  ATL: { latitude: 33.76, longitude: -84.40, indoors: true },
  BAL: { latitude: 39.28, longitude: -76.62 },
  BUF: { latitude: 42.77, longitude: -78.79 },
  CAR: { latitude: 35.23, longitude: -80.85 },
  CHI: { latitude: 41.86, longitude: -87.62 },
  CIN: { latitude: 39.10, longitude: -84.52 },
  CLE: { latitude: 41.51, longitude: -81.70 },
  DAL: { latitude: 32.75, longitude: -97.09, indoors: true },
  DEN: { latitude: 39.74, longitude: -105.02 },
  DET: { latitude: 42.34, longitude: -83.05, indoors: true },
  GB: { latitude: 44.50, longitude: -88.06 },
  HOU: { latitude: 29.68, longitude: -95.41, indoors: true },
  IND: { latitude: 39.76, longitude: -86.16, indoors: true },
  JAX: { latitude: 30.32, longitude: -81.64 },
  KC: { latitude: 39.05, longitude: -94.48 },
  LA: { latitude: 33.95, longitude: -118.34, indoors: true },
  LAC: { latitude: 33.95, longitude: -118.34, indoors: true },
  LAR: { latitude: 33.95, longitude: -118.34, indoors: true },
  LV: { latitude: 36.09, longitude: -115.18, indoors: true },
  MIA: { latitude: 25.96, longitude: -80.24 },
  MIN: { latitude: 44.97, longitude: -93.26, indoors: true },
  NE: { latitude: 42.09, longitude: -71.26 },
  NO: { latitude: 29.95, longitude: -90.08, indoors: true },
  NYG: { latitude: 40.81, longitude: -74.07 },
  NYJ: { latitude: 40.81, longitude: -74.07 },
  OAK: { latitude: 37.75, longitude: -122.20 },
  PHI: { latitude: 39.90, longitude: -75.17 },
  PIT: { latitude: 40.45, longitude: -80.02 },
  SD: { latitude: 32.78, longitude: -117.12 },
  SEA: { latitude: 47.60, longitude: -122.33 },
  SF: { latitude: 37.40, longitude: -121.97 },
  STL: { latitude: 38.63, longitude: -90.19, indoors: true },
  TB: { latitude: 27.98, longitude: -82.50 },
  TEN: { latitude: 36.17, longitude: -86.77 },
  WAS: { latitude: 38.91, longitude: -76.86 },
};

export interface Reading {
  team: string;
  week: number;
  /** the hour it kicks off, local, since an evening in December is cold */
  hour: number;
  temperature: number;
  wind?: number;
}

export interface Climate {
  /** a day at this ground in this week, drawn rather than averaged */
  drawTemperature: (
    team: string, week: number, hour: number, rng: () => number,
  ) => number;
  drawWind: (team: string, rng: () => number) => number;
  /** and the middle of such days, for anyone who wants one number */
  meanTemperature: (team: string, week: number, hour: number) => number;
}

/**
 * How far north it is, how late in the year, and what time it starts.
 * A night game in December runs about eight degrees colder than an
 * afternoon one, and the sun going down is the whole of the reason.
 */
const row = (latitude: number, week: number, hour: number) => {
  const north = (latitude - 38) / 10;
  const late = (week - 9) / 9;
  const night = hour >= 18 ? 1 : 0;
  const morning = hour < 15 ? 1 : 0;

  return [
    1,
    north,
    late,
    north * late,
    late ** 2,
    night,
    night * late,
    morning,
  ];
};

/** a ground with this many readings speaks entirely for itself */
const SETTLES_AT = 40;

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

const spreadOf = (xs: number[], middle: number) =>
  Math.sqrt(xs.reduce((s, x) => s + (x - middle) ** 2, 0) / Math.max(1, xs.length - 1));

/** a normal draw, since a day either side of the middle is as likely */
function bellDraw(rng: () => number): number {
  const a = Math.max(1e-9, rng());
  const b = rng();

  return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b);
}

export function fitClimate(readings: Reading[]): Climate {
  const usable = readings.filter((r) => HOME[r.team] && Number.isFinite(r.temperature));
  const weights = fitRidge(
    usable.map((r) => row(HOME[r.team]!.latitude, r.week, r.hour)),
    usable.map((r) => r.temperature),
    0.5,
  );
  const missBy = (r: Reading) =>
    r.temperature -
    predictRidge(weights, row(HOME[r.team]!.latitude, r.week, r.hour));

  const byGround = new Map<string, number[]>();
  const windAt = new Map<string, number[]>();

  for (const r of usable) {
    byGround.set(r.team, [...(byGround.get(r.team) ?? []), missBy(r)]);

    if (r.wind !== undefined && Number.isFinite(r.wind)) {
      windAt.set(r.team, [...(windAt.get(r.team) ?? []), r.wind]);
    }
  }

  const wholeSpread = spreadOf(usable.map(missBy), 0);
  const allWind = [...windAt.values()].flat();
  const windEverywhere = mean(allWind);
  const windSpread = spreadOf(allWind, windEverywhere);
  const offsetOf = new Map<string, { offset: number; spread: number }>();

  for (const [team, misses] of byGround) {
    // a ground with few readings leans on the curve rather than on its
    // own handful of afternoons
    const trust = misses.length / (misses.length + SETTLES_AT);
    const middle = mean(misses);
    offsetOf.set(team, {
      offset: trust * middle,
      spread: trust * spreadOf(misses, middle) + (1 - trust) * wholeSpread,
    });
  }

  const middleAt = (team: string, week: number, hour: number) => {
    const where = HOME[team];

    if (!where) {
      return 60;
    }

    return predictRidge(weights, row(where.latitude, week, hour)) +
      (offsetOf.get(team)?.offset ?? 0);
  };

  return {
    meanTemperature: middleAt,
    drawTemperature: (team, week, hour, rng) => {
      const spread = offsetOf.get(team)?.spread ?? wholeSpread;

      // nothing colder than the coldest game ever played, nor hotter
      return Math.max(-5, Math.min(105,
        middleAt(team, week, hour) + spread * bellDraw(rng)));
    },
    drawWind: (team, rng) => {
      const its = windAt.get(team) ?? [];
      const trust = its.length / (its.length + SETTLES_AT);
      const middle = trust * mean(its) + (1 - trust) * windEverywhere;
      const spread = trust * spreadOf(its, mean(its)) + (1 - trust) * windSpread;

      return Math.max(0, middle + spread * bellDraw(rng));
    },
  };
}
