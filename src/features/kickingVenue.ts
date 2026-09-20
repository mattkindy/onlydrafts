/**
 * What the ground and the weather do to a kick.
 *
 * A roof is worth nothing on a chip shot and about four points of
 * make rate from fifty, and a cold afternoon costs about the same, so
 * this belongs on the kick rather than on a kicker's season. Wind
 * looked helpful in the raw numbers, which it is not: staffs only
 * send a long one into a gale when they fancy it, so those attempts
 * are the easy ones and the rate reads high. So wind moves how often
 * he is sent out and never the kick itself.
 *
 * Fitted from every kick since 2015 in scripts/kickerWeatherEval.ts,
 * which drives these tables and any rival set through the factory.
 */

export interface Venue {
  indoors: boolean;
  /** degrees fahrenheit, when anyone recorded it */
  temperature?: number;
  /** miles an hour, which changes the choice more than the kick */
  wind?: number;
  /** millimetres over the three hours from kickoff, from a forecast */
  precipitation?: number;
  /** centimetres of snow over the same three hours */
  snowfall?: number;
}

/**
 * The state a kick is taken in. Wind is left out of `kickWeather`
 * because the attempts taken in one are picked, and a ball that is
 * both freezing and falling on takes whichever costs more rather than
 * both, since no cell has the kicks to price the pair.
 */
type Weather = "indoors" | "snow" | "freezing" | "cold" | "mild";
type Appetite = Weather | "wet" | "windy";

export interface KickingTables {
  /** make rate in each band, by what the day is doing */
  bands: { upTo: number; rates: Record<Weather, number> }[];
  extra: Record<Weather, number>;
  /** of the fourth downs in range, how often the kicker is sent out */
  sentOut: Record<Appetite, number>;
  /** the wind a staff starts thinking about, in miles an hour */
  windyAt: number;
  /** a millimetre over the three hours is a wet ball */
  soakedAt: number;
  freezingAt: number;
  coldAt: number;
}

/**
 * The tables as they ship. Every make rate is measured against `mild`,
 * which is what the bend divides by.
 *
 * The make rates keep the freezing row equal to the cold one. Splitting
 * them is within noise at every band, and the fifty plus row reads
 * higher in the freezing than in the mild, which is the same selection
 * that makes wind look helpful: a staff only tries a long one on a
 * brutal day when they fancy it. Appetite is where the cold shows, and
 * that is split three ways from 2015 on.
 */
export const SHIPPED_TABLES: KickingTables = {
  bands: [
    {
      upTo: 39,
      rates: {
        indoors: 0.965, mild: 0.967, cold: 0.95, freezing: 0.95, snow: 0.95,
      },
    },
    {
      upTo: 49,
      rates: {
        indoors: 0.840, mild: 0.812, cold: 0.76, freezing: 0.76, snow: 0.76,
      },
    },
    {
      upTo: 99,
      rates: {
        indoors: 0.738, mild: 0.700, cold: 0.66, freezing: 0.66, snow: 0.66,
      },
    },
  ],
  extra: {
    indoors: 0.961, mild: 0.949, cold: 0.932, freezing: 0.932, snow: 0.932,
  },
  /**
   * Measured over every fourth down from the 43 or closer since 2015.
   * Snow is the big one and it was priced as a mild afternoon before.
   * Rain on its own changes almost nothing a staff does, so `wet` is
   * nearly `mild` rather than carrying a term that was not there.
   */
  sentOut: {
    indoors: 0.69, mild: 0.644, windy: 0.629, cold: 0.576, freezing: 0.542,
    wet: 0.639, snow: 0.517,
  },
  windyAt: 12,
  soakedAt: 1,
  freezingAt: 32,
  coldAt: 40,
};

interface KickingVenue {
  /** what to multiply a make probability by, given the yard line */
  bend: (yardline: number, venue: Venue) => number;
  /** and how often an extra point goes over there */
  extraPoint: (venue: Venue) => number;
  /**
   * How willing a staff is to send him out at all, against an
   * ordinary afternoon. This matters more than the make rate: of the
   * fourth downs in range, they kick 69 in a hundred under a roof, 66
   * in the mild, 63 in a wind and 56 in the cold, going for it
   * instead. A cold weather kicker gets a fifth fewer attempts.
   */
  appetite: (venue: Venue) => number;
}

const snowing = (venue: Venue, tables: KickingTables) =>
  (venue.snowfall ?? 0) > 0 ||
  ((venue.precipitation ?? 0) >= tables.soakedAt &&
    (venue.temperature ?? 60) < tables.freezingAt);

const soaked = (venue: Venue, tables: KickingTables) =>
  (venue.precipitation ?? 0) >= tables.soakedAt;

/** what the day is, for a kick, with wind deliberately left out */
function kickWeather(venue: Venue, tables: KickingTables): Weather {
  if (venue.indoors) {
    return "indoors";
  }

  if (snowing(venue, tables)) {
    return "snow";
  }

  const temperature = venue.temperature ?? 60;

  if (temperature < tables.freezingAt) {
    return "freezing";
  }

  return temperature < tables.coldAt ? "cold" : "mild";
}

/** the same, plus the two a staff reads that a kicker does not */
function appetiteWeather(venue: Venue, tables: KickingTables): Appetite {
  const kick = kickWeather(venue, tables);

  if (kick !== "mild") {
    return kick;
  }

  if (soaked(venue, tables)) {
    return "wet";
  }

  return (venue.wind ?? 0) >= tables.windyAt ? "windy" : "mild";
}

/**
 * A reader over one set of tables. The shipped instance is below, and
 * the bench builds rival sets and scores them the same way.
 */
export function makeKickingVenue(tables: KickingTables): KickingVenue {
  const last = tables.bands[tables.bands.length - 1]!;

  return {
    bend: (yardline, venue) => {
      const yards = yardline + 17;
      const band = tables.bands.find((b) => yards <= b.upTo) ?? last;

      return band.rates[kickWeather(venue, tables)] / band.rates.mild;
    },
    extraPoint: (venue) => tables.extra[kickWeather(venue, tables)],
    appetite: (venue) =>
      tables.sentOut[appetiteWeather(venue, tables)] / tables.sentOut.mild,
  };
}

export const kickingVenue: KickingVenue = makeKickingVenue(SHIPPED_TABLES);
