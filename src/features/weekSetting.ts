/**
 * What the schedule already tells you about a week.
 *
 * The opponent is a weak signal in August: a defence keeps about a
 * fifth of itself from one season to the next, so a receiver's weeks
 * come out nearly flat and that is the right answer. The roof and the
 * kickoff time are not weak signals. They are printed on the schedule
 * and they will still be true in December.
 *
 * Fitted on 2016-2020 and checked on 2021-2025, keeping only the ones
 * that came back the same way and big enough to matter, then refitted
 * on every season.
 */

/** what the sky is doing at kickoff, from a forecast or from a record of one */
export interface Weather {
  /** miles an hour at ten metres */
  wind: number;
  /** Fahrenheit */
  temperature: number;
  /** a millimetre or more of rain over the three hours from kickoff, or snow */
  soaked: boolean;
}

/** a roof, a night kickoff, how many days off he had, and the sky */
export interface Setting {
  indoors: boolean;
  night: boolean;
  restDays: number;
  /** left out where nobody has a forecast, and then the weather costs nothing */
  weather?: Weather;
}

type Table = Partial<Record<string, number>>;

/** no wind and no rain, which the throwing game takes and the running game mostly does not */
const ROOF: Table = { QB: 1.0474, WR: 1.0510, TE: 1.0168 };

/** a Thursday, which the throwing game comes through and nobody else does */
const SHORT_WEEK: Table = { QB: 1.0523, WR: 1.0615 };

/** the late kickoff, which goes the other way and mostly on the ground */
const NIGHT: Table = { RB: 0.9703, WR: 0.9766 };

const SHORT_AT = 4;

/**
 * The weather groups the tables below were fitted on. A back who takes
 * more than a quarter of his touches through the air loses points to
 * wind and rain the way a receiver does; one who mostly runs does not,
 * and his fit went the other way in every training window, so he has
 * no row and the tables leave him alone.
 *
 * Fitted in scripts/weatherEval.ts on outdoor games from 2015 on,
 * checked out of sample on 2021 to 2025, then refitted on every season.
 */
type Group = "QB" | "RB catching" | "WR" | "TE";

/** a back is catching once this much of his touches comes through the air */
const CATCHING_AT = 0.281;

function groupOf(position: string, catchShare: number): Group | undefined {
  if (position === "RB") {
    return catchShare >= CATCHING_AT ? "RB catching" : undefined;
  }

  return position === "QB" || position === "WR" || position === "TE"
    ? position
    : undefined;
}

/** the weather a mild still dry afternoon is measured against */
const CALM_WIND = 10;
const MILD = 40;

/**
 * The roughest day the tables are asked about. Games this side of it
 * are most of what they were fitted on, and the corner term runs
 * positive for a tight end, so a blizzard read off the raw line would
 * come out as a lift rather than a cost.
 */
const WORST_WIND = 35;
const WORST_COLD = 0;

/** what a group loses per ten mph of wind over ten */
const WIND: Partial<Record<Group, number>> = {
  QB: -0.0967, "RB catching": -0.0525, WR: -0.0659, TE: -0.1429,
};

/** and per ten degrees under forty */
const COLD: Partial<Record<Group, number>> = {
  QB: -0.0499, "RB catching": -0.0235, WR: -0.0136, TE: -0.0352,
};

/** what a day that is both costs on top of the two */
const BOTH: Partial<Record<Group, number>> = {
  QB: -0.0366, "RB catching": 0.0254, WR: -0.0202, TE: 0.0444,
};

/** and what a soaking costs, which is the largest of the four */
const WET: Partial<Record<Group, number>> = {
  QB: -0.1252, "RB catching": -0.1513, WR: -0.1111, TE: -0.1182,
};

/** the weather moves a line, it does not get to halve one */
const MOST = 0.25;

function weatherFactor(group: Group, sky: Weather): number {
  const wind = Math.min(WORST_WIND, sky.wind);
  const temperature = Math.max(WORST_COLD, sky.temperature);
  const blowing = Math.max(0, wind - CALM_WIND) / 10;
  const cold = Math.max(0, MILD - temperature) / 10;
  const lost = blowing * (WIND[group] ?? 0) +
    cold * (COLD[group] ?? 0) +
    blowing * cold * (BOTH[group] ?? 0) +
    (sky.soaked ? WET[group] ?? 0 : 0);

  // every bin of every group scored under its line in weather, so a
  // day the tables like is a day they have extrapolated past
  return Math.min(1, Math.max(1 - MOST, 1 + lost));
}

/**
 * What to multiply his week by. Everything left out of the tables above
 * either went the other way on the check or was too small to show.
 *
 * `catchShare` is his targets over his touches across the same trailing
 * window the line is built from, and it only decides which side of the
 * running back split he falls on. A caller who does not know it leaves
 * a back out of the weather tables, which is what an unknown back most
 * likely wants anyway.
 */
export function settingLift(
  position: string,
  where: Setting,
  catchShare = 0,
): number {
  const roof = where.indoors ? ROOF[position] ?? 1 : 1;
  const short = where.restDays <= SHORT_AT ? SHORT_WEEK[position] ?? 1 : 1;
  const night = where.night ? NIGHT[position] ?? 1 : 1;
  const group = groupOf(position, catchShare);
  const sky = where.indoors || !where.weather || !group
    ? 1
    : weatherFactor(group, where.weather);

  return roof * short * night * sky;
}

/**
 * The lifts across a whole schedule average out to something other than
 * one, and his season projection is already settled, so this takes them
 * back to a mean of one and leaves only the shape.
 */
export function sharedOut(lifts: number[]): number[] {
  const middle = lifts.reduce((s, l) => s + l, 0) / Math.max(1, lifts.length);

  return middle > 0 ? lifts.map((l) => l / middle) : lifts.map(() => 1);
}
