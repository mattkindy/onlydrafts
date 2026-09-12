/**
 * The rest of a game, played out snap by snap in the browser.
 *
 * This is the Node simulator's drive and game loop again, reading the
 * reduced tables instead of the fitted model. The loop is the same one:
 * two sides alternate, a drive is a run of snaps that ends in a score,
 * a punt, a turnover or the downs, and the clock decides when to stop.
 *
 * A draw is one replay of the rest of the game. Every man in a game
 * shares a draw index, so two men on the same side rise and fall
 * together and nothing has to be correlated afterwards.
 */

import {
  bytesOf, distBand, DIST_BANDS, fieldBand, FIELD_BANDS, gainBand,
  marginBand, MARGIN_BANDS, QUANTILES, timeBand, TIME_BANDS, YARD_OFFSET,
  type SimTables,
} from "./simTables.ts";
import { payFor, type Pays } from "./scoring.ts";

/** what playing at home is worth, as the Node game applies it */
const AT_HOME = 1.024;
const KNEEL_BURNS = 41;
const TIMEOUT_SAVES = 39;
const ENDS_A_DRIVE = 20;
const LAST_GASP = 10;
const IN_RANGE = 45;

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
}

/** what one draw gave a man, in whatever the league pays */
export interface RemainderDraws {
  /** by the slate's key for a man, one number a draw */
  men: Map<string, Float64Array>;
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

/** a man's line over one replay, in the categories the scoring knows */
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
  men: { id: string; key: string; position: string }[];
  passerAt: number;
  runRate: Uint8Array;
  shares: Uint8Array;
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

function loadSide(
  tables: SimTables, team: string, against: string, lift: number,
): Loaded | null {
  const side = tables.teams[team];

  if (!side) {
    return null;
  }

  const order = tables.league.teamOrder;
  const row = tables.league.matchup[team];
  const at = order.indexOf(against);
  const bend = row && at >= 0 ? bytesOf(row) : null;

  return {
    team,
    men: side.men,
    passerAt: side.men.findIndex((man) => man.id === side.passer),
    runRate: bytesOf(side.runRate),
    shares: bytesOf(side.shares),
    caught: bytesOf(side.caught),
    gains: side.men.flatMap((man) => [
      bytesOf(side.gains[`${man.id}|run`] ?? ""),
      bytesOf(side.gains[`${man.id}|pass`] ?? ""),
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

/** who the ball goes to here, as an index into the side's men */
function goesTo(
  side: Loaded, call: number, down: number, yardline: number,
  uniform: () => number,
): number {
  const count = side.men.length;
  const block = ((call * 2 + (down >= 3 ? 1 : 0)) * FIELD_BANDS +
    fieldBand(yardline)) * count;
  let total = 0;

  for (let i = 0; i < count; i++) {
    total += side.shares[block + i] ?? 0;
  }

  if (total <= 0) {
    return count - 1;
  }

  let left = uniform() * total;

  for (let i = 0; i < count; i++) {
    left -= side.shares[block + i] ?? 0;

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

/** go, kick or punt on fourth down, drawn off the league's choices */
function fourthChoice(
  league: LeagueTables, yardline: number, toGo: number, uniform: () => number,
): number {
  const at = ((Math.max(1, Math.min(99, yardline)) - 1) * DIST_BANDS +
    distBand(toGo)) * 2;
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

/**
 * One drive. The caller keeps the score and the clock, so this only
 * says where the ball ends up, how long it took, and what each man did.
 */
function walkDrive(
  side: Loaded, league: LeagueTables, lines: Line[], uniform: () => number,
  startAt: number, margin: number, secondsLeft: number,
  openDown: number | undefined, openToGo: number | undefined,
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
  const budget = uniform() < league.isLast
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
      const choice = fourthChoice(league, yardline, toGo, uniform);

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

      if (passerAt >= 0 && passerAt !== who) {
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

/** one replay of the rest of a game, adding each man's line into `into` */
function playOut(
  home: Loaded, away: Loaded, league: LeagueTables, state: RemainderState,
  uniform: () => number, into: Map<Loaded, Line[]>,
): Record<string, number> {
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

    const drive = walkDrive(
      withBall, league, into.get(withBall)!, uniform, startAt, margin,
      secondsLeft, firstDown, firstToGo);
    firstDown = undefined;
    firstToGo = undefined;
    const took = Math.max(20, drive.took);
    const leftAfter = Math.max(0, secondsLeft - took);
    let scored = drive.ending === 0 ? 6 : drive.ending === 1 ? 3 : 0;

    if (drive.ending === 0) {
      const afterMargin = margin + 6;

      if (uniform() < goesForTwo(league, afterMargin, leftAfter)) {
        const call = uniform() <
          runRateAt(withBall, 1, 2, 2, afterMargin, leftAfter) ? 0 : 1;
        const who = goesTo(withBall, call, 1, 2, uniform);

        if (uniform() < league.twoPointRate) {
          scored = 8;
          into.get(withBall)![who]!.twoPointConversions++;

          if (call === 1 && withBall.passerAt >= 0 &&
              withBall.passerAt !== who) {
            into.get(withBall)![withBall.passerAt]!.twoPointConversions++;
          }
        }
      } else {
        scored = 6 + (uniform() < league.extraPointRate ? 1 : 0);
      }
    }

    if (drive.ending === 4 && drive.thrownAway && withBall.passerAt >= 0) {
      into.get(withBall)![withBall.passerAt]!.interceptions++;
    }

    points[withBall.team] = points[withBall.team]! + scored;
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
    const roll = uniform();

    if (roll >= 0.057) {
      const homeShare = home.lift / (home.lift + away.lift);
      const winner = uniform() < homeShare ? home.team : away.team;
      points[winner] = points[winner]! + (uniform() < 0.6 ? 3 : 6);
    }
  }

  return points;
}

/**
 * Every draw of the rest of one game, as points a man still has to come.
 *
 * The seed is the game's, so two calls about the same game at the same
 * snap give the same answer, and two different games never share a
 * stream.
 */
export function remainderFor(
  tables: SimTables, league: LeagueTables, state: RemainderState,
  draws: number, pays: Pays, seed: number,
): RemainderDraws | null {
  const home = loadSide(tables, state.home, state.away, AT_HOME);
  const away = loadSide(tables, state.away, state.home, 1 / AT_HOME);

  if (!home || !away) {
    return null;
  }

  const men = new Map<string, Float64Array>();
  const teamPoints: Record<string, Float64Array> = {
    [state.home]: new Float64Array(draws),
    [state.away]: new Float64Array(draws),
  };

  for (const side of [home, away]) {
    for (const man of side.men) {
      if (man.key && !men.has(man.key)) {
        men.set(man.key, new Float64Array(draws));
      }
    }
  }

  const lines = new Map<Loaded, Line[]>([
    [home, home.men.map(blankLine)],
    [away, away.men.map(blankLine)],
  ]);

  for (let draw = 0; draw < draws; draw++) {
    for (const side of [home, away]) {
      for (const line of lines.get(side)!) {
        line.passYds = 0; line.passTd = 0; line.interceptions = 0;
        line.rushYds = 0; line.rushTd = 0; line.receptions = 0;
        line.recYds = 0; line.recTd = 0; line.twoPointConversions = 0;
      }
    }

    const uniform = mulberry32(seed + draw * 104729);
    const points = playOut(home, away, league, state, uniform, lines);

    for (const team of [state.home, state.away]) {
      teamPoints[team]![draw] =
        (points[team] ?? 0) - (state.points[team] ?? 0);
    }

    for (const side of [home, away]) {
      const its = lines.get(side)!;

      for (let i = 0; i < side.men.length; i++) {
        const key = side.men[i]!.key;
        const his = key ? men.get(key) : undefined;

        if (his) {
          his[draw] = payFor(
            its[i]! as unknown as Record<string, number>, pays);
        }
      }
    }
  }

  return { men, teamPoints, draws };
}
