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
 * on every season. See scripts/knowableWeekEval.ts.
 */

/** a roof, a night kickoff, and how many days off he had */
export interface Setting {
  indoors: boolean;
  night: boolean;
  restDays: number;
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
 * What to multiply his week by. Everything left out of the tables above
 * either went the other way on the check or was too small to show.
 */
export function settingLift(position: string, where: Setting): number {
  const roof = where.indoors ? ROOF[position] ?? 1 : 1;
  const short = where.restDays <= SHORT_AT ? SHORT_WEEK[position] ?? 1 : 1;
  const night = where.night ? NIGHT[position] ?? 1 : 1;

  return roof * short * night;
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
