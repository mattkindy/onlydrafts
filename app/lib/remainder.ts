/**
 * The rest of a game, played out snap by snap in the browser.
 *
 * This is the Node simulator's drive and game loop again, reading the
 * reduced tables instead of the fitted model. The loop is the same one:
 * two sides alternate, a drive is a run of snaps that ends in a score,
 * a punt, a turnover or the downs, and the clock decides when to stop.
 * A game that finishes level plays an overtime period through the same
 * drives, so whoever wins it wins it on somebody's fantasy line.
 *
 * A draw is one replay of the rest of the game. Every player in a game
 * shares a draw index, so two players on the same side rise and fall
 * together and nothing has to be correlated afterwards.
 */

import {
  bytesOf, distBand, DIST_BANDS, fieldBand, FIELD_BANDS, gainBand,
  marginBand, MARGIN_BANDS, QUANTILES, timeBand, TIME_BANDS, YARD_OFFSET,
  type SimTables,
} from "./simTables.ts";
import { payFor, type Pays } from "./scoring.ts";
import { normalizeName } from "./store.ts";

/**
 * A defence under the key a lineup gives it. Sleeper and ESPN both call a
 * defence by its team code, and a lineup keys a player off his name, so
 * the code run through the same normalizing is the key to use here.
 */
export const defenceKeyOf = (team: string) => normalizeName(team);

/** what playing at home is worth, as the Node game applies it */
const AT_HOME = 1.024;
const KNEEL_BURNS = 41;
const TIMEOUT_SAVES = 39;
const ENDS_A_DRIVE = 20;
const LAST_GASP = 10;
const IN_RANGE = 45;

/** the fourth quarter, which is where starters start coming off */
const FOURTH_QUARTER = 900;

/** an overtime period in the regular season, and the longer playoff one */
const OVERTIME_SECONDS = 600;
const PLAYOFF_OVERTIME_SECONDS = 900;

/** the last week of the regular season, where a game may still end tied */
const LAST_REGULAR_WEEK = 18;

/** what each side gets back for an overtime period */
const OVERTIME_TIMEOUTS = 2;

/** possessions one overtime period is allowed before the loop gives up */
const OVERTIME_POSSESSIONS = 12;

/** and periods a playoff game is allowed before it is called a draw */
const OVERTIME_PERIODS = 4;

/** inside five minutes, where a side in front starts killing the clock */
const CLOCK_KILLING = 300;

/** from here on the standings have settled and starters get a rest */
const SETTLED_WEEK = 13;

/** the week the engine assumes when nobody tells it which one this is */
export const MID_SEASON_WEEK = 8;

/** what one starter keeps of his snaps in a lopsided fourth quarter */
interface Pull {
  /** the chance he comes off for good on a snap in this band */
  hazard: number;
  /** and what he keeps of his share while he is still on the field */
  scale: number;
  /** which inside five minutes becomes this instead */
  late?: number;
}

interface Band {
  /** the chance a starter is already off when the band first comes up */
  headStart: number;
  /** what the hazards are multiplied by from week thirteen on */
  rest: number;
  back: Pull;
  passer: Pull;
  receiver: Pull;
}

const STAYS_ON: Pull = { hazard: 0, scale: 1 };

/**
 * What a lopsided fourth quarter takes off a side's starters.
 *
 * The numbers come from a probe of 2021 to 2025 play by play, which
 * compared a side's touch shares in the fourth quarter against the same
 * side earlier in the same game. Two bands either side of even: a margin
 * of seventeen or more, where the top back and the quarterback come off
 * for good, and nine to sixteen, where a side behind rests its back and
 * its top receiver and a side in front only shifts work late.
 *
 * A side in front by seventeen takes its top receiver off too. A side behind
 * by that much keeps him on but spreads its targets wider, which is the
 * flat multiplier rather than a pull.
 */
const GARBAGE_TIME: Record<"up17" | "down17" | "up9" | "down9", Band> = {
  up17: {
    headStart: 0.2,
    rest: 1.5,
    back: { hazard: 0.055, scale: 1 },
    passer: { hazard: 0.11, scale: 1 },
    receiver: { hazard: 0.03, scale: 1 },
  },
  down17: {
    headStart: 0.2,
    rest: 1.5,
    back: { hazard: 0.055, scale: 1 },
    passer: { hazard: 0.11, scale: 1 },
    receiver: { hazard: 0, scale: 0.8 },
  },
  up9: {
    headStart: 0,
    rest: 1,
    back: { hazard: 0, scale: 1, late: 0.88 },
    passer: { hazard: 0, scale: 1, late: 0.66 },
    receiver: STAYS_ON,
  },
  down9: {
    headStart: 0,
    rest: 1,
    back: { hazard: 0.03, scale: 1 },
    passer: STAYS_ON,
    receiver: { hazard: 0.02, scale: 1 },
  },
};

/** which band this snap is in, off the margin the side with the ball sees */
function bandOf(margin: number, clock: number): Band | null {
  if (clock > FOURTH_QUARTER || Math.abs(margin) < 9) {
    return null;
  }

  if (Math.abs(margin) >= 17) {
    return margin > 0 ? GARBAGE_TIME.up17 : GARBAGE_TIME.down17;
  }

  return margin > 0 ? GARBAGE_TIME.up9 : GARBAGE_TIME.down9;
}

export interface RemainderState {
  home: string;
  away: string;
  points: Record<string, number>;
  secondsLeft: number;
  withBall?: string;
  yardline?: number;
  down?: number;
  toGo?: number;
  timeouts: Record<string, number>;
  warningLeft: boolean;
  secondHalf: boolean;
  receivedFirst?: string;
  /**
   * What a player who has gone off keeps of the snaps still to come, by
   * the key the slate gives him. Anyone left out keeps all of his.
   */
  shareScale?: Record<string, number>;
  /**
   * Which week of the season this is. Starters come off earlier once the
   * standings have settled, so the engine needs to know.
   */
  week?: number;
  /**
   * Seconds left in an overtime period already under way. Regulation is
   * over when this is set, so the engine plays out the overtime period
   * and leaves `secondsLeft` alone.
   */
  overtimeLeft?: number;
}

/** what one draw gave a player, in whatever the league pays */
export interface RemainderDraws {
  /**
   * By the slate's key for a player, one number a draw. Each side's
   * defence is in here too, under the normalized team code a league
   * gives it, since a defence is scored off the same draws.
   */
  players: Map<string, Float64Array>;
  /** and the two sides' remaining points, for anyone checking the game */
  teamPoints: Record<string, Float64Array>;
  draws: number;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** a player's line over one replay, in the categories the scoring knows */
interface Line {
  passYds: number; passTd: number; interceptions: number;
  rushYds: number; rushTd: number;
  receptions: number; recYds: number; recTd: number;
  twoPointConversions: number;
}

const blankLine = (): Line => ({
  passYds: 0, passTd: 0, interceptions: 0, rushYds: 0, rushTd: 0,
  receptions: 0, recYds: 0, recTd: 0, twoPointConversions: 0,
});

/** one side, with its tables read out of base64 once */
interface Loaded {
  team: string;
  players: { id: string; key: string; position: string }[];
  passerAt: number;
  runRate: Uint8Array;
  shares: Uint8Array;
  /** one multiplier a player, where any of them has gone off */
  scale: Float64Array | null;
  /** the busiest back and the busiest receiver, the two the fourth quarter hits */
  topBack: number;
  topReceiver: number;
  /** one flag a player, set once he has come off for the rest of a draw */
  pulled: Uint8Array;
  /** whether the twenty percent already off has been rolled in this draw */
  headStarted: boolean;
  /** what each player keeps of his share at this snap, a draw's pulls included */
  keeps: Float64Array;
  caught: Uint8Array;
  gains: Uint8Array[];
  lift: number;
  matchup: { run: number; pass: number };
}

/** the league tables, read out once and shared by every game */
export interface LeagueTables {
  kickSucceeds: Uint8Array;
  punt: Uint8Array[];
  turnover: Uint8Array;
  secondsFor: Uint8Array;
  gainScale: Uint8Array;
  fourth: Uint8Array;
  goesForTwo: Uint8Array;
  penalty: Uint8Array;
  twoPointRate: number;
  extraPointRate: number;
  penaltyFirstDown: number;
  offenceFlag: number;
  defenceFlag: number;
  maxPlays: number;
  isLast: number;
}

export function leagueOf(tables: SimTables): LeagueTables {
  const league = tables.league;

  return {
    kickSucceeds: bytesOf(league.kickSucceeds),
    punt: Array.from({ length: FIELD_BANDS }, (_, band) =>
      bytesOf(league.puntQuantiles[band] ?? "")),
    turnover: bytesOf(league.turnover),
    secondsFor: bytesOf(league.secondsFor),
    gainScale: bytesOf(league.gainScale),
    fourth: bytesOf(league.fourth),
    goesForTwo: bytesOf(league.goesForTwo),
    penalty: bytesOf(league.penaltyQuantiles),
    twoPointRate: league.twoPointRate,
    extraPointRate: league.extraPointRate,
    penaltyFirstDown: league.rules.penaltyFirstDown,
    offenceFlag: league.rules.offenceFlag,
    defenceFlag: league.rules.defenceFlag,
    maxPlays: league.rules.maxPlays,
    isLast: league.rules.isLast,
  };
}

/** the scales this side's players are on, or null where nobody is hurt */
function scalesFor(
  men: { key: string }[], shareScale: Record<string, number> | undefined,
): Float64Array | null {
  if (!shareScale) {
    return null;
  }

  const scales = Float64Array.from(men, (man) => shareScale[man.key] ?? 1);

  return scales.some((one) => one !== 1) ? scales : null;
}

/**
 * The one player at a position with the most work in the side's shares.
 *
 * Adding a player's weight over every block puts the man a staff would
 * take off first at the top, without asking the slate for a depth chart.
 */
function busiestAt(
  men: { position: string }[], shares: Uint8Array, positions: string[],
): number {
  const totals = new Float64Array(men.length);

  for (let at = 0; at < shares.length; at++) {
    const i = at % men.length;
    totals[i] = totals[i]! + (shares[at] ?? 0);
  }

  let best = -1;

  for (let i = 0; i < men.length; i++) {
    if (!positions.includes(men[i]!.position)) {
      continue;
    }

    if (best < 0 || totals[i]! > totals[best]!) {
      best = i;
    }
  }

  return best;
}

function loadSide(
  tables: SimTables, team: string, against: string, lift: number,
  shareScale: Record<string, number> | undefined,
): Loaded | null {
  const side = tables.teams[team];

  if (!side) {
    return null;
  }

  const order = tables.league.teamOrder;
  const row = tables.league.matchup[team];
  const at = order.indexOf(against);
  const bend = row && at >= 0 ? bytesOf(row) : null;
  const shares = bytesOf(side.shares);

  return {
    team,
    players: side.men,
    passerAt: side.men.findIndex((player) => player.id === side.passer),
    runRate: bytesOf(side.runRate),
    shares,
    scale: scalesFor(side.men, shareScale),
    topBack: busiestAt(side.men, shares, ["RB", "FB"]),
    topReceiver: busiestAt(side.men, shares, ["WR", "TE"]),
    pulled: new Uint8Array(side.men.length),
    headStarted: false,
    keeps: new Float64Array(side.men.length).fill(1),
    caught: bytesOf(side.caught),
    gains: side.men.flatMap((player) => [
      bytesOf(side.gains[`${player.id}|run`] ?? ""),
      bytesOf(side.gains[`${player.id}|pass`] ?? ""),
    ]),
    lift,
    matchup: bend
      ? { run: (bend[at * 2] ?? 128) / 128, pass: (bend[at * 2 + 1] ?? 128) / 128 }
      : { run: 1, pass: 1 },
  };
}

/** where a kickoff leaves the side receiving it, as the Node game draws it */
const kickedTo = (uniform: () => number) =>
  uniform() < 0.62 ? 70 : Math.round(60 + uniform() * 20);

/** a draw off sixteen quantiles, smoothed between the two either side */
function fromQuantiles(table: Uint8Array, uniform: () => number): number {
  if (!table.length) {
    return 0;
  }

  const at = uniform() * QUANTILES;
  const low = Math.min(QUANTILES - 1, Math.floor(at));
  const high = Math.min(QUANTILES - 1, low + 1);
  const part = at - low;
  const mixed = (table[low] ?? YARD_OFFSET) * (1 - part) +
    (table[high] ?? YARD_OFFSET) * part;

  return Math.round(mixed) - YARD_OFFSET;
}

const runRateAt = (
  side: Loaded, down: number, toGo: number, yardline: number,
  margin: number, secondsLeft: number,
) => {
  const at = ((((Math.min(4, down) - 1) * DIST_BANDS + distBand(toGo)) *
    FIELD_BANDS + fieldBand(yardline)) * MARGIN_BANDS + marginBand(margin)) *
    TIME_BANDS + timeBand(secondsLeft);

  return (side.runRate[at] ?? 128) / 255;
};

/**
 * How likely one player is to get the ball here. Cutting his weight and
 * leaving his teammates alone is what hands his snaps to them.
 */
const shareAt = (side: Loaded, block: number, i: number) =>
  (side.shares[block + i] ?? 0) * (side.scale ? side.scale[i] ?? 1 : 1) *
  (side.keeps[i] ?? 1);

/** the three men a lopsided fourth quarter moves, in a fixed order */
const startersOf = (side: Loaded, band: Band): [number, Pull][] => [
  [side.topBack, band.back],
  [side.passerAt, band.passer],
  [side.topReceiver, band.receiver],
];

/** every starter still on keeps all of his share, which overtime does too */
function keepsWhoIsLeft(side: Loaded): void {
  for (let i = 0; i < side.keeps.length; i++) {
    side.keeps[i] = side.pulled[i] ? 0 : 1;
  }
}

/**
 * Roll this snap's pulls and say what each starter keeps of his share.
 *
 * Called on every snap, because a margin that narrows again puts the
 * flat multipliers back to one. A player already off stays off for the
 * rest of the draw.
 */
function pullStarters(
  side: Loaded, margin: number, clock: number, week: number,
  uniform: () => number,
): void {
  const band = bandOf(margin, clock);

  if (!band) {
    keepsWhoIsLeft(side);

    return;
  }

  const rest = week >= SETTLED_WEEK ? band.rest : 1;
  const opening = band.headStart > 0 && !side.headStarted;

  if (opening) {
    side.headStarted = true;
  }

  for (const [at, how] of startersOf(side, band)) {
    if (at < 0) {
      continue;
    }

    const comesOff = how.hazard <= 0
      ? 0
      : (opening ? band.headStart : how.hazard * rest);

    if (!side.pulled[at] && comesOff > 0 && uniform() < comesOff) {
      side.pulled[at] = 1;
    }

    const staysFor = clock <= CLOCK_KILLING && how.late !== undefined
      ? how.late
      : how.scale;
    side.keeps[at] = side.pulled[at] ? 0 : staysFor;
  }
}

/** nobody has come off yet, which is where every draw starts */
function backOnTheField(side: Loaded): void {
  side.pulled.fill(0);
  side.headStarted = false;
  side.keeps.fill(1);
}

/** whether the side's passer is still on to be paid for a throw */
const passerOn = (side: Loaded) =>
  side.passerAt >= 0 && side.keeps[side.passerAt] !== 0;

/** who the ball goes to here, as an index into the side's players */
function goesTo(
  side: Loaded, call: number, down: number, yardline: number,
  uniform: () => number,
): number {
  const count = side.players.length;
  const block = ((call * 2 + (down >= 3 ? 1 : 0)) * FIELD_BANDS +
    fieldBand(yardline)) * count;
  let total = 0;

  for (let i = 0; i < count; i++) {
    total += shareAt(side, block, i);
  }

  if (total <= 0) {
    return count - 1;
  }

  let left = uniform() * total;

  for (let i = 0; i < count; i++) {
    left -= shareAt(side, block, i);

    if (left <= 0) {
      return i;
    }
  }

  return count - 1;
}

const gainScaleAt = (
  league: LeagueTables, call: number, down: number, toGo: number,
  yardline: number,
) => {
  const at = ((call * 4 + (Math.min(4, down) - 1)) * DIST_BANDS +
    distBand(toGo)) * FIELD_BANDS + fieldBand(yardline);

  return (league.gainScale[at] ?? 64) / 64;
};

const secondsAt = (
  league: LeagueTables, call: number, gained: number, margin: number,
  secondsLeft: number,
) => {
  const at = ((call * 5 + gainBand(gained)) * MARGIN_BANDS +
    marginBand(margin)) * TIME_BANDS + timeBand(secondsLeft);

  return league.secondsFor[at] ?? 30;
};

const turnoverAt = (
  league: LeagueTables, call: number, down: number, yardline: number,
) => {
  const at = (call * 4 + (Math.min(4, down) - 1)) * FIELD_BANDS +
    fieldBand(yardline);

  return (league.turnover[at] ?? 25) / 2550;
};

/**
 * Go, kick or punt on fourth down. The score and the clock move this a
 * long way: a side behind in the fourth goes for it where the same side
 * level in the first would punt.
 */
function fourthChoice(
  league: LeagueTables, yardline: number, toGo: number, margin: number,
  secondsLeft: number, uniform: () => number,
): number {
  const at = ((((Math.max(1, Math.min(99, yardline)) - 1) * DIST_BANDS +
    distBand(toGo)) * MARGIN_BANDS + marginBand(margin)) * TIME_BANDS +
    timeBand(secondsLeft)) * 2;
  const go = (league.fourth[at] ?? 30) / 255;
  const kick = (league.fourth[at + 1] ?? 0) / 255;
  const drawn = uniform();

  if (drawn < go) {
    return 0;
  }

  return drawn < go + kick ? 1 : 2;
}

interface DriveOutcome {
  /** 0 touchdown, 1 field goal, 2 missed kick, 3 punt, 4 turnover, 5 downs, 6 clock */
  ending: number;
  handsOverAt: number;
  took: number;
  thrownAway: boolean;
}

/** the ending that hands the ball over, which is what a defence is paid for */
const TURNOVER = 4;

/** what a defence saw over one draw, in the events a league pays it for */
interface Takeaways {
  /** drives faced, which is what the per drive rates are scaled by */
  drives: number;
  int: number;
  fumRec: number;
}

const blankTakeaways = (): Takeaways => ({ drives: 0, int: 0, fumRec: 0 });

/**
 * What a defence does per drive it faces, beyond the takeaways the drive
 * loop hands it.
 *
 * Fitted from the curated weekly defence file against the drive file:
 * 2.38 sacks, 0.12 defensive touchdowns, 0.025 safeties and 0.058
 * blocked kicks a team a game, over 10.7 drives faced a game. A drive
 * that ends on a missed kick is a miss rather than a block, so blocks
 * are drawn here as well.
 *
 * A defensive touchdown drawn this way pays the defence without putting
 * the seven on the scoreboard. Eight a season a side is rare enough that
 * feeding it back into the score would move nothing else.
 */
const PER_DRIVE: Record<string, number> = {
  sack: 0.222, def_td: 0.0114, safe: 0.0024, blk_kick: 0.0054,
};

/** the top of each points allowed bucket, in the order a league steps them */
const PTS_ALLOW: [number, string][] = [
  [0, "pts_allow_0"], [6, "pts_allow_1_6"], [13, "pts_allow_7_13"],
  [20, "pts_allow_14_20"], [27, "pts_allow_21_27"], [34, "pts_allow_28_34"],
];

const PTS_ALLOW_WORST = "pts_allow_35p";

const bucketFor = (allowed: number): string =>
  PTS_ALLOW.find(([top]) => allowed <= top)?.[1] ?? PTS_ALLOW_WORST;

/** what a league pays for holding a side to this many points */
const bucketPay = (allowed: number, pays: Pays) =>
  payFor({ [bucketFor(allowed)]: 1 }, pays);

/** Knuth's draw, which is quick enough while the mean stays under one */
function poisson(mean: number, uniform: () => number): number {
  if (mean <= 0) {
    return 0;
  }

  const floor = Math.exp(-mean);
  let product = uniform();
  let count = 0;

  while (product > floor) {
    product *= uniform();
    count++;
  }

  return count;
}

/**
 * What a defence has left to come, in whatever the league pays.
 *
 * The provider's running total already prices the points allowed bucket
 * at the current score, which is why a defence looks like a shutout
 * at kickoff. So the bucket at the score this draw finishes on comes in
 * and the bucket at the current score comes back out, and what is left
 * is the sacks and takeaways still to happen. Whatever the provider has
 * paid for those already stays where it is.
 */
function defencePoints(
  saw: Takeaways, allowedSoFar: number, allowedToCome: number, pays: Pays,
  uniform: () => number,
): number {
  const parts: Record<string, number> = { int: saw.int, fum_rec: saw.fumRec };

  for (const [event, rate] of Object.entries(PER_DRIVE)) {
    parts[event] = poisson(rate * saw.drives, uniform);
  }

  return payFor(parts, pays) +
    bucketPay(allowedSoFar + allowedToCome, pays) -
    bucketPay(allowedSoFar, pays);
}

/**
 * One drive. The caller keeps the score and the clock, so this only
 * says where the ball ends up, how long it took, and what each player did.
 *
 * In overtime nobody comes off, and no drive is cut short for being the
 * last of a half, since the caller ends one on the clock or on a score.
 */
function playDrive(
  side: Loaded, league: LeagueTables, lines: Line[], uniform: () => number,
  startAt: number, margin: number, secondsLeft: number,
  openDown: number | undefined, openToGo: number | undefined, week: number,
  overtime: boolean,
): DriveOutcome {
  let down = openDown ?? 1;
  let toGo = openToGo === undefined ? 10 : Math.min(openToGo, startAt);
  let yardline = startAt;
  let clock = secondsLeft;
  let took = 0;
  let sinceLastSnap = 0;
  let plays = 0;
  let thrownAway = false;
  const passerAt = side.passerAt;
  const budget = !overtime && uniform() < league.isLast
    ? 1 + Math.floor(uniform() * 12)
    : Infinity;
  const ended = (ending: number, handsOverAt: number): DriveOutcome => ({
    ending, handsOverAt,
    took: Math.max(ENDS_A_DRIVE, took - sinceLastSnap + ENDS_A_DRIVE),
    thrownAway,
  });
  const kicks = () => {
    const goesOver = (league.kickSucceeds[Math.min(99, yardline)] ?? 0) / 255;

    return uniform() < goesOver
      ? ended(1, 75)
      : ended(2, 100 - Math.min(92, yardline + 8));
  };

  for (;;) {
    if (plays >= Math.min(league.maxPlays, budget)) {
      return ended(6, 75);
    }

    const halfEnding = clock > 1800 && clock - 1800 <= LAST_GASP;
    const gameEnding = clock <= LAST_GASP && margin >= -3 && margin <= 0;

    if ((halfEnding || gameEnding) && down < 4 && yardline <= IN_RANGE) {
      return kicks();
    }

    if (down === 4) {
      const choice =
        fourthChoice(league, yardline, toGo, margin, clock, uniform);

      if (choice === 1) {
        return kicks();
      }

      if (choice === 2) {
        const landed = fromQuantiles(league.punt[fieldBand(yardline)]!, uniform);

        return ended(3, Math.max(20, Math.min(95, landed)));
      }
    }

    if (uniform() < league.penaltyFirstDown) {
      yardline = Math.max(1, yardline - fromQuantiles(league.penalty, uniform));
      down = 1;
      toGo = Math.min(10, yardline);
      plays++;
      sinceLastSnap = secondsAt(league, 1, 0, margin, clock);
      took += sinceLastSnap;
      clock = Math.max(0, clock - sinceLastSnap);
      continue;
    }

    if (uniform() < league.offenceFlag) {
      const back = Math.min(5, Math.floor((100 - yardline) / 2));
      yardline += back;
      toGo = Math.min(toGo + back, yardline);
      plays++;
      sinceLastSnap = secondsAt(league, 1, 0, margin, clock);
      took += sinceLastSnap;
      clock = Math.max(0, clock - sinceLastSnap);
      continue;
    }

    if (overtime) {
      keepsWhoIsLeft(side);
    } else {
      pullStarters(side, margin, clock, week, uniform);
    }

    const call = uniform() <
      runRateAt(side, down, toGo, yardline, margin, clock) ? 0 : 1;

    if (uniform() < turnoverAt(league, call, down, yardline)) {
      thrownAway = call === 1;

      return ended(4, 100 - yardline);
    }

    const who = goesTo(side, call, down, yardline, uniform);
    const holds = (side.caught[who * 2 + call] ?? 255) / 255;
    const bend = call === 0 ? side.matchup.run : side.matchup.pass;
    const caught = call === 0 ||
      uniform() < Math.min(1, holds * Math.min(bend, 1.2));
    let gained = 0;

    if (caught) {
      const drawn = fromQuantiles(side.gains[who * 2 + call]!, uniform);
      const scale = gainScaleAt(league, call, down, toGo, yardline) *
        side.lift * (drawn > 0 ? Math.min(bend, 1.2) : 1);
      gained = Math.min(yardline, Math.round(drawn * scale));
    }

    const scored = yardline - gained <= 0;
    const line = lines[who]!;

    if (call === 0) {
      line.rushYds += gained;
      if (scored) line.rushTd++;
    } else if (caught) {
      line.receptions++;
      line.recYds += gained;
      if (scored) line.recTd++;

      // a backup throwing is rarely anybody's fantasy starter, so once
      // the passer is off nobody is paid for the throw
      if (passerAt !== who && passerOn(side)) {
        const threw = lines[passerAt]!;
        threw.passYds += gained;
        if (scored) threw.passTd++;
      }
    }

    plays++;
    sinceLastSnap = secondsAt(league, call, gained, margin, clock);
    took += sinceLastSnap;
    clock = Math.max(0, clock - sinceLastSnap);
    yardline -= gained;

    if (yardline <= 0) {
      return ended(0, 75);
    }

    if (gained >= toGo) {
      down = 1;
      toGo = Math.min(10, yardline);
      continue;
    }

    toGo -= gained;
    down++;

    if (down > 4) {
      return ended(5, 100 - yardline);
    }
  }
}

/** how often a side goes for two here, off the margin and the clock */
const goesForTwo = (
  league: LeagueTables, margin: number, secondsLeft: number,
) => {
  const at = (Math.max(-25, Math.min(25, margin)) + 25) * 2 +
    (secondsLeft <= 120 ? 1 : 0);

  return (league.goesForTwo[at] ?? 24) / 255;
};

/** an interception goes on the passer's line, where he is still on */
function chargeThrownAway(side: Loaded, lines: Line[]): void {
  if (passerOn(side)) {
    lines[side.passerAt]!.interceptions++;
  }
}

/**
 * What a drive put on the board, the try after a touchdown included.
 *
 * In overtime the try is always a kick. A side there is playing for the
 * next score rather than for a two point margin, and the fitted two
 * point table knows nothing about a period where one score ends it.
 */
function scoredOn(
  drive: DriveOutcome, side: Loaded, league: LeagueTables, lines: Line[],
  margin: number, leftAfter: number, overtime: boolean, uniform: () => number,
): number {
  if (drive.ending === 1) {
    return 3;
  }

  if (drive.ending !== 0) {
    return 0;
  }

  const afterMargin = margin + 6;

  if (!overtime && uniform() < goesForTwo(league, afterMargin, leftAfter)) {
    const call = uniform() <
      runRateAt(side, 1, 2, 2, afterMargin, leftAfter) ? 0 : 1;
    const who = goesTo(side, call, 1, 2, uniform);

    if (uniform() >= league.twoPointRate) {
      return 6;
    }

    lines[who]!.twoPointConversions++;

    if (call === 1 && side.passerAt !== who && passerOn(side)) {
      lines[side.passerAt]!.twoPointConversions++;
    }

    return 8;
  }

  return 6 + (uniform() < league.extraPointRate ? 1 : 0);
}

/** the two sides and the tables, which every period of one game shares */
interface Playing {
  home: Loaded;
  away: Loaded;
  league: LeagueTables;
  into: Map<Loaded, Line[]>;
  week: number;
  /** what each side's defence saw, by team, over the draw being played */
  saw: Record<string, Takeaways>;
}

/** one more drive faced, and the turnover where the drive ended in one */
function defenceFaced(saw: Takeaways, drive: DriveOutcome): void {
  saw.drives++;

  if (drive.ending !== TURNOVER) {
    return;
  }

  if (drive.thrownAway) {
    saw.int++;

    return;
  }

  saw.fumRec++;
}

/** where an overtime period picks up */
interface Kickoff {
  withBall: Loaded;
  startAt: number;
  secondsLeft: number;
  down?: number;
  toGo?: number;
  /** how many sides have already had the ball in this period */
  had: number;
}

const overtimeSecondsFor = (week: number) =>
  week > LAST_REGULAR_WEEK ? PLAYOFF_OVERTIME_SECONDS : OVERTIME_SECONDS;

/** a fresh period, with the coin flip deciding who receives */
const firstKickoff = (
  game: Playing, uniform: () => number,
): Kickoff => ({
  withBall: uniform() < 0.5 ? game.home : game.away,
  startAt: kickedTo(uniform),
  secondsLeft: overtimeSecondsFor(game.week),
  had: 0,
});

/**
 * One overtime period, played drive by drive like the rest of the game,
 * so whatever is scored lands on the players who scored it.
 *
 * Both sides get the ball. After that any score ends it, which covers
 * the trailing side answering a field goal with a touchdown. A defensive
 * score on the first possession would end it there, but a drive here
 * never gives the defence points, so that case does not come up. A
 * regular season period that ends level leaves the game tied.
 */
function playOvertime(
  game: Playing, points: Record<string, number>, uniform: () => number,
  opening: Kickoff,
): void {
  const { home, away, league } = game;
  let withBall = opening.withBall;
  let against = withBall === home ? away : home;
  let startAt = opening.startAt;
  let secondsLeft = opening.secondsLeft;
  let down = opening.down;
  let toGo = opening.toGo;
  let had = opening.had;

  for (let gone = 0; secondsLeft > 0 && gone < OVERTIME_POSSESSIONS; gone++) {
    const lines = game.into.get(withBall)!;
    const margin = points[withBall.team]! - points[against.team]!;
    const drive = playDrive(
      withBall, league, lines, uniform, startAt, margin, secondsLeft, down,
      toGo, game.week, true);
    down = undefined;
    toGo = undefined;
    const took = Math.max(20, drive.took);
    const leftAfter = Math.max(0, secondsLeft - took);
    points[withBall.team] = points[withBall.team]! +
      scoredOn(drive, withBall, league, lines, margin, leftAfter, true, uniform);

    if (drive.ending === 4 && drive.thrownAway) {
      chargeThrownAway(withBall, lines);
    }

    defenceFaced(game.saw[against.team]!, drive);
    secondsLeft = leftAfter;
    had++;

    if (had >= 2 && points[home.team] !== points[away.team]) {
      return;
    }

    startAt = drive.ending === 0 || drive.ending === 1
      ? kickedTo(uniform)
      : Math.max(1, Math.min(99, Math.round(drive.handsOverAt)));
    const wasOn = withBall;
    withBall = against;
    against = wasOn;
  }
}

/**
 * Overtime until somebody leads, which is one period in the regular
 * season and as many as it takes in the playoffs.
 *
 * `resuming` is the period a live game is already in. Without it the
 * game has only now finished level and a coin flip starts a fresh one.
 */
function playExtraTime(
  game: Playing, points: Record<string, number>,
  timeouts: Record<string, number>, uniform: () => number,
  resuming?: Kickoff,
): void {
  let opening = resuming ?? firstKickoff(game, uniform);

  for (let period = 0; period < OVERTIME_PERIODS; period++) {
    timeouts[game.home.team] = OVERTIME_TIMEOUTS;
    timeouts[game.away.team] = OVERTIME_TIMEOUTS;
    playOvertime(game, points, uniform, opening);

    if (points[game.home.team] !== points[game.away.team] ||
        game.week <= LAST_REGULAR_WEEK) {
      return;
    }

    opening = firstKickoff(game, uniform);
  }
}

/**
 * One replay of the rest of a game, adding each player's line into `into`.
 *
 * The two sides' scores come back, and with them what each defence saw,
 * since the drives it faced are what its own line is drawn off.
 */
function playOut(
  home: Loaded, away: Loaded, league: LeagueTables, state: RemainderState,
  uniform: () => number, into: Map<Loaded, Line[]>,
): { points: Record<string, number>; saw: Record<string, Takeaways> } {
  const points: Record<string, number> = {
    [home.team]: state.points[home.team] ?? 0,
    [away.team]: state.points[away.team] ?? 0,
  };
  const flipped = uniform() < 0.5 ? home : away;
  const receivedFirst = state.receivedFirst
    ? (state.receivedFirst === home.team ? home : away)
    : flipped;
  const opening = kickedTo(uniform);
  let withBall = state.withBall
    ? (state.withBall === home.team ? home : away)
    : (flipped === home ? away : home);
  let against = withBall === home ? away : home;
  let startAt = state.yardline ?? opening;
  let firstDown = state.down;
  let firstToGo = state.toGo;
  let secondsLeft = state.secondsLeft;
  const timeouts: Record<string, number> = {
    [home.team]: state.timeouts[home.team] ?? 3,
    [away.team]: state.timeouts[away.team] ?? 3,
  };
  let warningLeft = state.warningLeft;
  let secondHalf = state.secondHalf;
  let drives = 0;
  const saw: Record<string, Takeaways> = {
    [home.team]: blankTakeaways(),
    [away.team]: blankTakeaways(),
  };
  const game: Playing = {
    home, away, league, into, week: state.week ?? MID_SEASON_WEEK, saw,
  };
  const overtimeLeft = state.overtimeLeft ?? 0;

  if (overtimeLeft > 0) {
    // a live period with the sides level may still owe somebody a
    // possession; level is the only way to tell, since a lead in
    // overtime ends the game unless the trailing side is answering
    const had = points[home.team] === points[away.team] ? 0 : 2;
    playExtraTime(game, points, timeouts, uniform, {
      withBall, startAt, secondsLeft: overtimeLeft, down: firstDown,
      toGo: firstToGo, had,
    });

    return { points, saw };
  }

  while (secondsLeft > 0 && drives < 40) {
    if (!secondHalf && secondsLeft <= 1800) {
      secondHalf = true;
      withBall = receivedFirst;
      against = withBall === home ? away : home;
      startAt = kickedTo(uniform);
      timeouts[home.team] = 3;
      timeouts[away.team] = 3;
      warningLeft = true;
      firstDown = undefined;
      firstToGo = undefined;
    }

    const margin = points[withBall.team]! - points[against.team]!;
    const stops = timeouts[against.team]! +
      (warningLeft && secondsLeft > 120 ? 1 : 0);
    const kneelable = 3 * KNEEL_BURNS - stops * TIMEOUT_SAVES;

    if (margin > 0 && secondHalf && secondsLeft <= Math.max(6, kneelable)) {
      break;
    }

    const lines = into.get(withBall)!;
    const drive = playDrive(
      withBall, league, lines, uniform, startAt, margin,
      secondsLeft, firstDown, firstToGo, game.week, false);
    firstDown = undefined;
    firstToGo = undefined;
    const took = Math.max(20, drive.took);
    const leftAfter = Math.max(0, secondsLeft - took);
    const scored = scoredOn(
      drive, withBall, league, lines, margin, leftAfter, false, uniform);

    if (drive.ending === 4 && drive.thrownAway) {
      chargeThrownAway(withBall, lines);
    }

    points[withBall.team] = points[withBall.team]! + scored;
    defenceFaced(game.saw[against.team]!, drive);
    drives++;

    if (secondHalf && secondsLeft <= 300 && margin > 0 &&
        timeouts[against.team]! > 0) {
      timeouts[against.team] =
        timeouts[against.team]! - Math.min(timeouts[against.team]!, 2);
    }

    if (warningLeft && secondsLeft - took < 120) {
      warningLeft = false;
    }

    secondsLeft = Math.max(0, secondsLeft - took);
    startAt = drive.ending === 0 || drive.ending === 1
      ? kickedTo(uniform)
      : Math.max(1, Math.min(99, Math.round(drive.handsOverAt)));
    const wasOn = withBall;
    withBall = against;
    against = wasOn;
  }

  if (points[home.team] === points[away.team]) {
    playExtraTime(game, points, timeouts, uniform);
  }

  return { points, saw };
}

/**
 * Every draw of the rest of one game, as points a player still has to come.
 *
 * The seed is the game's, so two calls about the same game at the same
 * snap give the same answer, and two different games never share a
 * stream.
 */
export function remainderFor(
  tables: SimTables, league: LeagueTables, state: RemainderState,
  draws: number, pays: Pays, seed: number,
): RemainderDraws | null {
  const home =
    loadSide(tables, state.home, state.away, AT_HOME, state.shareScale);
  const away =
    loadSide(tables, state.away, state.home, 1 / AT_HOME, state.shareScale);

  if (!home || !away) {
    return null;
  }

  const players = new Map<string, Float64Array>();
  const teamPoints: Record<string, Float64Array> = {
    [state.home]: new Float64Array(draws),
    [state.away]: new Float64Array(draws),
  };

  for (const side of [home, away]) {
    for (const player of side.players) {
      if (player.key && !players.has(player.key)) {
        players.set(player.key, new Float64Array(draws));
      }
    }
  }

  for (const team of [state.home, state.away]) {
    players.set(defenceKeyOf(team), new Float64Array(draws));
  }

  const lines = new Map<Loaded, Line[]>([
    [home, home.players.map(blankLine)],
    [away, away.players.map(blankLine)],
  ]);

  for (let draw = 0; draw < draws; draw++) {
    for (const side of [home, away]) {
      backOnTheField(side);

      for (const line of lines.get(side)!) {
        line.passYds = 0; line.passTd = 0; line.interceptions = 0;
        line.rushYds = 0; line.rushTd = 0; line.receptions = 0;
        line.recYds = 0; line.recTd = 0; line.twoPointConversions = 0;
      }
    }

    const uniform = mulberry32(seed + draw * 104729);
    const { points, saw } = playOut(home, away, league, state, uniform, lines);

    for (const team of [state.home, state.away]) {
      teamPoints[team]![draw] =
        (points[team] ?? 0) - (state.points[team] ?? 0);
    }

    for (const team of [state.home, state.away]) {
      const against = team === state.home ? state.away : state.home;
      players.get(defenceKeyOf(team))![draw] = defencePoints(
        saw[team]!, state.points[against] ?? 0, teamPoints[against]![draw]!,
        pays, uniform);
    }

    for (const side of [home, away]) {
      const its = lines.get(side)!;

      for (let i = 0; i < side.players.length; i++) {
        const key = side.players[i]!.key;
        const his = key ? players.get(key) : undefined;

        if (his) {
          // a passer's throws come from whoever caught them rather than
          // from his own share, so his snaps have to be cut here as well
          const cut = i === side.passerAt ? side.scale?.[i] ?? 1 : 1;

          his[draw] = cut * payFor(
            its[i]! as unknown as Record<string, number>, pays);
        }
      }
    }
  }

  return { players, teamPoints, draws };
}
