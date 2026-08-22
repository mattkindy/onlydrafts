/**
 * What the ground and the weather do to a kick.
 *
 * A roof is worth nothing on a chip shot and about four points of
 * make rate from fifty, and a cold afternoon costs about the same, so
 * this belongs on the kick rather than on a kicker's season. Wind
 * looked helpful in the raw numbers, which it is not: staffs only
 * send a long one into a gale when they fancy it, so those attempts
 * are the easy ones and the rate reads high.
 *
 * Fitted from every kick since 2019, by band, so the numbers move
 * when the data does.
 */

export interface Venue {
  indoors: boolean;
  /** degrees fahrenheit, when anyone recorded it */
  temperature?: number;
  /** miles an hour, which changes the choice more than the kick */
  wind?: number;
}

export interface KickingVenue {
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

const BANDS = [
  { upTo: 39, indoors: 0.965, mild: 0.967, cold: 0.95 },
  { upTo: 49, indoors: 0.840, mild: 0.812, cold: 0.76 },
  { upTo: 99, indoors: 0.738, mild: 0.700, cold: 0.66 },
];

const EXTRA = { indoors: 0.961, mild: 0.949, cold: 0.932 };
/** of the fourth downs in range, how often the kicker is sent out */
const SENT_OUT = { indoors: 0.69, mild: 0.66, windy: 0.63, cold: 0.56 };
const WINDY = 12;

const isCold = (venue: Venue) =>
  !venue.indoors && (venue.temperature ?? 60) < 40;

const rateFor = (band: typeof BANDS[number], venue: Venue) =>
  venue.indoors ? band.indoors : isCold(venue) ? band.cold : band.mild;

/**
 * The bend is a ratio to what a kick of that length makes on an
 * ordinary afternoon, so the fitted distance curve keeps its shape
 * and only the ground moves it.
 */
export const kickingVenue: KickingVenue = {
  bend: (yardline, venue) => {
    const yards = yardline + 17;
    const band = BANDS.find((b) => yards <= b.upTo) ?? BANDS[BANDS.length - 1]!;

    return rateFor(band, venue) / band.mild;
  },
  extraPoint: (venue) =>
    venue.indoors ? EXTRA.indoors : isCold(venue) ? EXTRA.cold : EXTRA.mild,
  appetite: (venue) => {
    const sent = venue.indoors ? SENT_OUT.indoors
      : isCold(venue) ? SENT_OUT.cold
      : (venue.wind ?? 0) >= WINDY ? SENT_OUT.windy
      : SENT_OUT.mild;

    return sent / SENT_OUT.mild;
  },
};
