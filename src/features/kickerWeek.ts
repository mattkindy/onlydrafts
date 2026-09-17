/**
 * A kicker's coming week, as parts a league can pay for itself.
 *
 * His board number is a season divided by fifteen, which says the same
 * thing every week whatever the fixture. This projects a week instead:
 * the paid total comes off his own recent weeks and what the line
 * expects his side to score, and the ground moves how often a staff
 * sends him out at all. The total is handed back as rates so a league
 * with its own ladder pays it the way it pays the board.
 *
 * The weights come from the kickerWeekEval bench, fitted on the 2022 to
 * 2025 weeks together.
 */

import { poisson, seededRng } from "../sim/rng.js";
import { alsoCounted, BANDS } from "./kickerFromWalk.js";
import { kickingVenue, type Venue } from "./kickingVenue.js";

export type Parts = Record<string, number>;

/** the categories a kicker's week is counted in, before the rollups */
export const KICKER_PARTS = [
  ...BANDS.map((band) => `fgm_${band.name}`),
  ...BANDS.map((band) => `fgmiss_${band.name}`),
  "xpm", "xpmiss",
];

/**
 * What a kicker is paid where a league says nothing else: three for a
 * short one, four from forty, five from fifty, a point an extra point
 * and a point off a miss. Yardage is left at nothing, since a league
 * that pays by the yard says so and one that does not would have every
 * kicker's week read half as high again.
 */
export const STANDARD_KICKER_PAYS: Parts = {
  fgm_0_19: 3, fgm_20_29: 3, fgm_30_39: 3, fgm_40_49: 4,
  fgm_50_59: 5, fgm_60p: 5,
  fgmiss_0_19: -1, fgmiss_20_29: -1, fgmiss_30_39: -1, fgmiss_40_49: -1,
  fgmiss_50_59: 0, fgmiss_60p: 0,
  xpm: 1, xpmiss: -1,
};

export function payKicker(parts: Parts, pays: Parts): number {
  return Object.entries(parts)
    .reduce((sum, [part, n]) => sum + n * (pays[part] ?? 0), 0);
}

/**
 * Expecting a side to score more costs its kicker points rather than
 * paying him them: a drive that reaches the end zone is an extra point
 * where a drive that stalls is a field goal, and three beats one. The
 * fit says so and the sign is not a mistake.
 */
const PAID_BASE = 9.931;
const PAID_PER_OWN_RECENT = 0.0752;
const PAID_PER_IMPLIED_FOR = -0.1122;

/** what a kicker counted a game across 2022 to 2025 */
const LEAGUE_PARTS: Parts = {
  fgm_0_19: 0.0063, fgm_20_29: 0.4062, fgm_30_39: 0.5229, fgm_40_49: 0.453,
  fgm_50_59: 0.3285, fgm_60p: 0.013,
  fgmiss_0_19: 0, fgmiss_20_29: 0.0077, fgmiss_30_39: 0.0254,
  fgmiss_40_49: 0.0912, fgmiss_50_59: 0.1082, fgmiss_60p: 0.0125,
  xpm: 2.1165, xpmiss: 0.0705,
};

/** and what that paid a game, for a kicker with nothing behind him */
export const LEAGUE_PAID =
  payKicker(alsoCounted(LEAGUE_PARTS), STANDARD_KICKER_PAYS);

/** how many of his own games a kicker needs before his rates lead */
const SHRINK_GAMES = 8;

/** the most recent weeks of his own the paid fit reads */
export const TRAILING_WEEKS = 6;

/**
 * How far the counting rates may be moved to meet the paid total, so a
 * week whose fit and whose rates pull apart does not come back with
 * five field goals or with none.
 */
const SCALE_BAND: [number, number] = [0.6, 1.5];

export interface KickerWeekRead {
  /** his own paid weeks this season, oldest first */
  ownPaid: number[];
  /** his paid number a game last season, read until he has his own */
  lastYearPaid: number;
  /** his counting parts a game, over the weeks behind `ownGames` */
  ownParts: Parts;
  ownGames: number;
  /** what the line expects his side to score */
  impliedFor: number;
  /** the ground he kicks at, which decides how often he is sent out */
  venue: Venue;
}

interface KickerWeekLine {
  parts: Parts;
  paid: number;
}

const mean = (its: number[]) =>
  its.length ? its.reduce((sum, n) => sum + n, 0) / its.length : 0;

/**
 * The shape of the counting parts before they are scaled: his own rate
 * where he has games behind him, the league's where he does not, with
 * the field goals moved by how freely the ground gives them up.
 */
function countingShape(read: KickerWeekRead): Parts {
  const own = Math.min(1, read.ownGames / (read.ownGames + SHRINK_GAMES));
  const sentOut = kickingVenue.appetite(read.venue);
  const out: Parts = {};

  for (const part of KICKER_PARTS) {
    const league = LEAGUE_PARTS[part] ?? 0;
    const rate = own * (read.ownParts[part] ?? league) + (1 - own) * league;
    out[part] = part.startsWith("fg") ? rate * sentOut : rate;
  }

  return out;
}

/**
 * A week's worth of weeks, so a floor and a ceiling can be read off
 * them. Every kick is a rare event drawn at the rate we expect him to
 * take it at, which is what gives a kicker his two point Sunday and his
 * eighteen point one.
 */
export function drawKickerWeeks(
  parts: Parts, pays: Parts, seed: number, draws = 2000,
): number[] {
  const rand = seededRng(seed);
  const out: number[] = [];

  for (let i = 0; i < draws; i++) {
    const week: Parts = {};

    for (const part of KICKER_PARTS) {
      week[part] = poisson(parts[part] ?? 0, rand);
    }

    out.push(payKicker(alsoCounted(week), pays));
  }

  return out.sort((a, b) => a - b);
}

export function projectKickerWeek(read: KickerWeekRead): KickerWeekLine {
  const recent = read.ownPaid.slice(-TRAILING_WEEKS);
  const trailing = recent.length ? mean(recent) : read.lastYearPaid;
  const wanted = PAID_BASE +
    PAID_PER_OWN_RECENT * trailing +
    PAID_PER_IMPLIED_FOR * read.impliedFor;
  const shape = countingShape(read);
  const fromShape = payKicker(shape, STANDARD_KICKER_PAYS);
  const [least, most] = SCALE_BAND;
  const scale = fromShape > 0
    ? Math.min(most, Math.max(least, wanted / fromShape))
    : 1;
  const parts: Parts = {};

  for (const part of KICKER_PARTS) {
    parts[part] = Number(((shape[part] ?? 0) * scale).toFixed(4));
  }

  const whole = alsoCounted(parts);

  return { parts: whole, paid: payKicker(whole, STANDARD_KICKER_PAYS) };
}
