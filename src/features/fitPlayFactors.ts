/**
 * The play factors, counted against the exact state and widened only
 * when a question is asked of a thin one.
 *
 * Storing by bucket decides in advance what resolution every question
 * gets. Storing by state and widening on demand lets the goal line keep
 * its own numbers, where the counts are large, while fourth and
 * nineteen at the forty seven borrows from around it.
 */

import {
  emptyCell, keysAt, stateKey, wideningPacked,
  type Call, type PlayFactors, type PlayState, type StateCell,
} from "../model/playFactors.js";
import type { RunParts } from "./runParts.js";
import type { PlayLevel } from "./playLevel.js";
import { bandOf, type TargetDepth } from "./targetDepth.js";
import type { Formation } from "./fitFormation.js";
import type { Coverage } from "./fitCoverage.js";
import type { Look } from "./fitLook.js";
import type { AfterCatch } from "./fitAfterCatch.js";

export interface PlayRow {
  /** which season it happened, so an old play can count for less */
  season?: number;
  /** whether the quarterback stood back, which moves the call most */
  shotgun?: boolean;
  /** and what the defence had on the field, when it is recorded */
  shell?: string;
  manZone?: string;
  /** who had the ball and who was trying to stop them */
  offence: string;
  defence: string;
  down: number;
  toGo: number;
  yardline: number;
  /** this team's lead, and the clock, which move what a coach calls */
  margin: number;
  secondsLeft: number;
  call: Call;
  yards: number;
  touchdown: number;
  /** who had it, empty when the play is only being counted */
  player: string;
  /** and who threw it, empty on a carry or when nobody was credited */
  passer?: string;
  /** how far downfield it was thrown, absent on a carry */
  airYards?: number;
  /** whether anybody caught it, absent on a carry */
  caught?: boolean;
  /** and what he made once it was his */
  afterCatch?: number;
}

export interface FactorSettings {
  /** plays needed before a state speaks for itself */
  least: number;
  /**
   * Whether who gets the ball moves with how the game is going.
   * Only for turning it off in a comparison; it is on otherwise.
   */
  readsTheScript?: boolean;
  /**
   * And how many the call needs, which is fewer. A run rate is one
   * number and eighty plays place it within about six points; a
   * distribution of yards wants far more. Asking both for three
   * hundred meant no state ever had enough under its own clock and
   * score, so the call never moved with the game.
   */
  leastForCall: number;
  /** touches needed before a man's own share at a state is believed */
  leastForMan: number;
  /** plays needed before one side's own numbers are believed */
  leastForSide: number;
  /**
   * And how many are needed among the plays that had room to run this
   * far, before that narrower pool is used instead of all of them.
   */
  leastWithRoom: number;
  /**
   * Beyond this far from the goal, a gain is drawn only from plays
   * that had room to run that far. Closer in nothing is being cut off
   * by the end zone that was not going to be short anyway.
   */
  roomBeyond: number;
  /**
   * And not past here either. Backed up against his own goal a side
   * has only 3,808 plays that had the room, and their long rate falls
   * to 5.0% against 5.8% for all of them, so the cut makes the pool
   * worse rather than better.
   */
  roomUpTo: number;
}

export const FACTOR_DEFAULTS: FactorSettings = {
  least: 300, leastForCall: 80, leastForMan: 40, leastForSide: 60,
  leastWithRoom: 60,
  /**
   * Swept over the drive shape. Beyond the five the touchdowns land
   * at 23.6% against 23.8% and the long ones at 20.6% against 24%.
   * Applying it everywhere sends the red zone to 62% against 57%, and
   * from the twenty out the touchdowns fall to 21.7%.
   */
  roomBeyond: 5,
  roomUpTo: 99,
};

/** what somebody managed over a set of plays, at whatever scope */
export interface Rate {
  touches: number;
  yards: number;
  /** and how many of them went for twenty or more */
  long: number;
}

const emptyRate = (): Rate => ({ touches: 0, yards: 0, long: 0 });

const addTo = (into: Map<string, Rate>, key: string, yards: number): void => {
  const own = into.get(key) ?? emptyRate();
  own.touches++;
  own.yards += yards;
  if (yards >= 20) own.long++;
  into.set(key, own);
};

/** everything counted at one state, plus who touched it there */
export interface Counted extends StateCell {
  byPlayer: Map<string, {
    touches: number; yards: number; scores: number;
    /** and how often he breaks a long one, which is his own and lasts */
    long: number;
  }>;
  /**
   * Where each gain came from, since a gain is cut off by the goal
   * line. A play from the forty one cannot make more than forty one
   * yards, so pooling it in with the forty five caps what a draw there
   * can produce and halves the long scores.
   */
  from: number[];
  /**
   * And the same again over the plays a player was named on.
   *
   * A tenth of passes are sacks, which nobody is credited with and
   * which average four and a third yards backwards. Comparing a
   * receiver's yards against a league average that includes them makes
   * every receiver look 21% better than he is.
   */
  named: Rate;
  /**
   * And the gains kept apart by how far downfield the throw went.
   *
   * A checkdown gains nothing a quarter of the time and makes seven
   * when it works; a shot past twenty-five gains nothing two thirds of
   * the time and makes thirty-nine. Drawing both from one pool gives
   * every receiver the same throw.
   */
  byDepth: Map<number, number[]>;
  /**
   * And where each of those was thrown from, in step with them, so a
   * throw can be drawn from spots that had the field in front of them
   * to run into. A catch on the five never made more than five yards,
   * and pooling it with the rest is why the walk scores from distance
   * a third as often as anybody does.
   */
  byDepthFrom: Map<number, number[]>;
}

const emptyCounted = (): Counted =>
  ({
    ...emptyCell(), byPlayer: new Map(), from: [], named: emptyRate(),
    byDepth: new Map(), byDepthFrom: new Map(),
  });

/**
 * Which depth this throw goes to, from what happens here tilted by how
 * this man is used.
 *
 * Taking his own mix straight would throw deep at the goal line
 * because that is what he does over a season. The situation says what
 * depths happen here and his leaning says which of them are his.
 */
const bandHere = (
  cell: Counted, leaning: number[], uniform: () => number,
): number => {
  const weights: number[] = [];
  let total = 0;

  for (let band = 0; band < leaning.length; band++) {
    const here = (cell.byDepth.get(band) ?? []).length;
    const weight = here * (leaning[band] ?? 1);
    weights.push(weight);
    total += weight;
  }

  if (total <= 0) {
    return 0;
  }

  let left = uniform() * total;

  for (let band = 0; band < weights.length; band++) {
    left -= weights[band]!;

    if (left <= 0) {
      return band;
    }
  }

  return weights.length - 1;
};

/**
 * The gains at one depth, borrowing from the bands beside it when
 * that one is thin.
 *
 * Falling back to every depth at this spot is what a thin band used to
 * do, and it quietly turned a deep throw into an average one: a shot
 * past twenty-five is worth thirty-nine yards when it works and the
 * pool of all throws is worth six. A band next door is much closer to
 * the truth than no band at all.
 */
const gainsAtDepth = (cell: Counted, band: number, room = 0): number[] => {
  const found: number[] = [];
  const take = (at: number) => {
    const gains = cell.byDepth.get(at) ?? [];
    const from = cell.byDepthFrom.get(at) ?? [];

    for (let i = 0; i < gains.length; i++) {
      if (room <= 0 || (from[i] ?? 0) >= room) {
        found.push(gains[i]!);
      }
    }
  };

  take(band);

  for (let step = 1; step < 6 && found.length < 40; step++) {
    for (const beside of [band - step, band + step]) {
      take(beside);
    }
  }

  /**
   * Asking for room this far out leaves too little to draw from near
   * the halfway line, where only a throw from a side's own end has it.
   * Better a throw that could not have run as far as this one might
   * than no throw of this depth at all.
   */
  return room > 0 && found.length < 20 ? gainsAtDepth(cell, band) : found;
};

/**
 * The gains from spots with at least this much field in front of them.
 *
 * Kept in the order they were counted, so the yards and where they
 * came from line up.
 */
const roomFor = (cell: Counted, yardline: number): number[] => {
  const found: number[] = [];

  for (let i = 0; i < cell.yards.length; i++) {
    if ((cell.from[i] ?? 0) >= yardline) {
      found.push(cell.yards[i]!);
    }
  }

  return found;
};

const countIn = (rate: Rate, yards: number): void => {
  rate.touches++;
  rate.yards += yards;
  if (yards >= 20) rate.long++;
};

/**
 * What share of his offence's work each man is expected to take.
 *
 * Left out, the factors divide the work by what each man did before,
 * which is the weakest way we have of guessing a share: .596 against
 * .747 for working it out from who he is competing with. Passed in,
 * that model sets how much a man gets and the history only says where
 * he gets it.
 */
export type ProjectedShares = Map<string, number>;

/**
 * The same, with the two halves of a man's work kept apart.
 *
 * One combined share lets a receiver's target volume leak onto run
 * plays. With the halves separate, a carry is divided by who competes
 * for carries and a throw by who competes for targets.
 */
export type SplitProjected = Map<string, { carries: number; targets: number }>;

/**
 * What these two sides together do to a play, against what an average
 * pair does.
 *
 * The counts below ask each side on its own, so an offence that has
 * gained a lot and a defence that has given up little multiply
 * together as though neither had met the other. They also cannot see a
 * defence whose men have changed since those plays.
 */
export type Pairing = (offence: string, defence: string, call: Call) => number;

export type { RunParts } from "./runParts.js";

export type { PlayLevel } from "./playLevel.js";

/** everything the counting pass produces, which is all the fit needs */
/**
 * The plays themselves, kept whole, so an outcome can be drawn as a
 * package instead of assembled from parts.
 *
 * A man's play carries its yards and its catch together, correlated
 * the way reality correlated them, and drawing his own play needs no
 * multiplier, no catch table and no centring, because nothing is a
 * ratio. The pooled path stays for the men too thin to sample.
 */
export interface PlayStore {
  /** what a throw to nobody costs, and where it was thrown from */
  wasted: { yardline: number; yards: number }[];
  /** by tens of the yardline, since one throw in seven is wasted inside the ten */
  wastedShareAt: (yardline: number) => number;
  down: Int8Array;
  toGo: Int16Array;
  yardline: Int8Array;
  yards: Int16Array;
  caught: Uint8Array;
  /** how many seasons before the latest each play happened */
  age: Int8Array;
  /** `${player}|${call}` to the rows that were his */
  ofMan: Map<string, number[]>;
  /** `${player}|${passer}` to the throws between exactly those two */
  ofPair: Map<string, number[]>;
}

/**
 * How close to the goal a play has to be drawn from somewhere like the
 * spot it is used. Out in the field the room does not matter much; in
 * close it decides everything, because a play from midfield applied on
 * the eight is a different play.
 */
const NEAR_GOAL = Number(process.env["NEAR_GOAL"] ?? 30);
/**
 * How much nearer the goal a borrowed play may have been made. A man
 * standing on the eighteen was drawing his own plunges from the two,
 * and they pulled the 11 to 30 bands 8 to 13% short of what plays
 * there gain, which is where drives stalled into field goals.
 */
const CLOSER = Number(process.env["CLOSER"] ?? 8);
/** the same guard past the thirty, where forty yards of slack let a
 * man at midfield draw plays whose gains the goal line had capped */
const FIELD_CLOSER = Number(process.env["FIELD_CLOSER"] ?? 40);
/**
 * How much a play a season old counts against one from the latest
 * season, in a man's own pool. Drawing all four seasons evenly gave a
 * man his old form: Taylor drew 5.0 a carry off seasons he has not
 * run since, while Bijan's climb to 5.4 was watered to 4.7.
 */
const RECENT_FADE = Number(process.env["RECENT_FADE"] ?? 0.7);
const FADES = [0, 1, 2, 3, 4, 5].map((back) => Math.pow(RECENT_FADE, back));
/** and how much harder the formation cells fade, since their rate climbs */
const FORM_FADE = Number(process.env["FORM_FADE"] ?? 0.7);
const FORM_FADES = [0, 1, 2, 3, 4, 5].map((b) => Math.pow(FORM_FADE, b));

/**
 * Three switches for asking how much of a man the walk is using, all
 * off where they sit, and none of them paying on the board yet.
 *
 * HOW_FAR raises his level to a power, 0 turning it off. NO_LONG_SHAPE
 * drops the long gain correction from that level. FROM_COUNTS moves
 * the level of who gets the ball off the projection and onto the
 * counts, 1 being all counts. scripts/playLayerEval.ts reads them.
 */
const HOW_FAR = Number(process.env["HOW_FAR"] ?? 1);
const FROM_COUNTS = Number(process.env["FROM_COUNTS"] ?? 0);

/**
 * How near the line a throw has to be before room is asked of its pool.
 *
 * Twenty five reads .331 a week against .327 for asking nowhere, and
 * makes 1031 touchdowns against 931 where 1430 happened. Asking further
 * out gives back both, .319 at forty and .316 everywhere, since out
 * there the throws with the field in front of them are throws from a
 * side's own end and those are different plays.
 */
const DEPTH_ROOM_UPTO = Number(process.env["DEPTH_ROOM_UPTO"] ?? 25);

export function storePlays(rows: PlayRow[]): PlayStore {
  const kept = rows.filter((r) => r.player);
  const down = new Int8Array(kept.length);
  const toGo = new Int16Array(kept.length);
  const yardline = new Int8Array(kept.length);
  const yards = new Int16Array(kept.length);
  const caught = new Uint8Array(kept.length);
  const ofMan = new Map<string, number[]>();
  const ofPair = new Map<string, number[]>();
  /**
   * The sacks and the balls thrown away, which belong to no receiver
   * and so are in nobody's pool. Kept with where the ball was, because
   * one inside the ten costs 3.12 yards and one past midfield costs
   * 4.72: a side near the goal throws it away rather than take the
   * sack, and has less field to lose.
   */
  const nobody = rows.filter((r) => r.call === "pass" && !r.player);
  const wastedBand = (yardline: number) => Math.min(9, Math.floor(yardline / 10));
  const wastedOf = new Array(10).fill(0);
  const passesOf = new Array(10).fill(0);

  for (const r of rows) {
    if (r.call !== "pass") {
      continue;
    }

    passesOf[wastedBand(r.yardline)]++;

    if (!r.player) {
      wastedOf[wastedBand(r.yardline)]++;
    }
  }

  const age = new Int8Array(kept.length);
  const latest = kept.reduce((most, r) => Math.max(most, r.season ?? 0), 0);

  kept.forEach((r, i) => {
    down[i] = r.down;
    toGo[i] = r.toGo;
    yardline[i] = r.yardline;
    yards[i] = r.yards;
    caught[i] = r.call === "run" || r.caught ? 1 : 0;
    age[i] = r.season ? latest - r.season : 0;
    const key = `${r.player}|${r.call}`;
    ofMan.set(key, [...(ofMan.get(key) ?? []), i]);

    if (r.call === "pass" && r.passer) {
      const pair = `${r.player}|${r.passer}`;
      ofPair.set(pair, [...(ofPair.get(pair) ?? []), i]);
    }
  });

  return {
    down, toGo, yardline, yards, caught, age, ofMan, ofPair,
    wasted: nobody.map((r) => ({ yardline: r.yardline, yards: r.yards })),
    wastedShareAt: (yardline) => {
      const band = wastedBand(yardline);

      return passesOf[band]! > 0 ? wastedOf[band]! / passesOf[band]! : 0.105;
    },
  };
}

/**
 * How the afternoon is going for the side with the ball, which
 * changes who gets it.
 *
 * A team down two scores throws to different men than one protecting
 * a lead, and a third and long is a different play from a first down.
 * The full state cells know this but never have enough plays to say
 * so about one man, so the same question is asked again in six coarse
 * buckets where everybody has hundreds.
 */
export const scriptOf = (margin: number, down: number, toGo: number) => {
  const how = margin <= -9 ? "chasing" : margin >= 9 ? "ahead" : "level";
  const mustThrow = down >= 3 && toGo >= 4;

  return `${how}|${mustThrow ? "long" : "normal"}`;
};

/**
 * How often a call is a run from each formation, by down, distance
 * and where the ball is. The formation is drawn before the call, so
 * this is the second half of that draw rather than another way of
 * asking the same question.
 */
export const formationBandOf = (
  call: Call, shotgun: boolean, yardline: number,
) =>
  `${call}|${shotgun ? "gun" : "centre"}|` +
  `${yardline <= 20 ? "close" : yardline <= 60 ? "middle" : "back"}`;

export const atFormation = (
  shotgun: boolean, down: number, toGo: number, yardline: number,
  /**
   * And how the game stands, because the pooled call reads both and
   * a formation table that ignores them takes the game situation
   * away from the call: a side two scores down late throws whatever
   * it lines up in.
   */
  margin?: number, secondsLeft?: number,
) => {
  const spot = `${shotgun ? "gun" : "centre"}|${Math.min(4, down)}|` +
    `${toGo <= 2 ? "short" : toGo <= 6 ? "medium" : "long"}|` +
    `${Math.min(9, Math.floor(yardline / 10))}`;

  if (margin === undefined || secondsLeft === undefined) {
    return spot;
  }

  const how = margin <= -9 ? "chasing" : margin >= 9 ? "ahead" : "level";

  return `${spot}|${how}|${secondsLeft <= 900 ? "late" : "early"}`;
};

export interface CountedPlays {
  cells: Map<string, Counted>;
  /** what each formation led to, for the two step call */
  fromFormation: Map<string, { plays: number; runs: number }>;
  /** and what a play from each formation came to */
  yardsFromFormation: Map<
    string, { plays: number; yards: number; dry: number; long: number }
  >;
  /** and the same with the shell the defence answered with */
  againstLook: Map<string, { plays: number; yards: number; dry: number }>;
  byOffence: Map<string, Counted>;
  byDefence: Map<string, Counted>;
  byMan: Map<string, Rate>;
  leagueOn: Map<string, Rate>;
  /** `${script}|${call}|${player}` to how often he took it there */
  inScript: Map<string, number>;
  /** and `${script}|${call}` to how often anybody did */
  scriptPlays: Map<string, number>;
  /** `${player}|${call}` to how often he took it anywhere */
  onCall: Map<string, number>;
  /** and how often anybody did, by call */
  callPlays: Map<string, number>;
  caughtAt: Map<number, { threw: number; caught: number }>;
  overall: Map<string, number>;
  everyTouch: number;
}

/** everything the factors can be handed beyond the plays themselves */
export interface FactorExtras {
  /** each man's expected share of the work, one number for all of it */
  projected?: ProjectedShares;
  /** the same with the two halves kept apart, which wins if both given */
  split?: SplitProjected;
  /** what one side does to another, from the network */
  pairing?: Pairing;
  runParts?: RunParts;
  /**
   * One model for the level with everybody on the play at once. Given
   * it, the per-man and per-side multipliers stand down.
   */
  playLevel?: PlayLevel;
  /** how far downfield each man is thrown, which picks his pool */
  depth?: TargetDepth;
  /** the men on that defence this week, and the quarterback */
  people?: {
    defenceNow?: (defence: string, season: number, week: number, call: Call) => number;
    passing?: (receiver: string, passer: string) => number;
  };
  /**
   * The counting already done, so eight shares of one job do not each
   * count the same rows. From countPlays, usually by way of the disk.
   */
  counted?: CountedPlays;
  /** the plays kept whole, which turns the draw personal */
  plays?: PlayStore;
  /** where each side stands before the snap, drawn before the call */
  formation?: Formation;
  /** what the defence plays, and who a side throws to against it */
  coverage?: Coverage;
  /** and what it puts on the field against a formation */
  look?: Look;
  /** what each man makes once the ball is his, near one */
  afterCatch?: AfterCatch;
  /**
   * Who resembles whom, nearest first, so a man too thin to sample
   * borrows plays from men like him before falling to the crowd. A
   * possession receiver widens to possession receivers.
   */
  alike?: Map<string, string[]>;
}

/**
 * The counting pass on its own, so it can run once and be kept.
 *
 * Everything below reads what this produces and none of it needs the
 * rows again, which is what lets eight shares of one job load the
 * counts instead of each counting 141 thousand rows.
 */
export function countPlays(
  rows: PlayRow[], wantsSides = true,
): CountedPlays {
  const cells = new Map<string, Counted>();
  const freshest = rows.reduce((most, r) => Math.max(most, r.season ?? 0), 0);
  /**
   * The same counts again per offence and per defence.
   *
   * Every side was walked with the league's numbers, so two teams
   * differed only in who took the ball off them, and the model had no
   * skill on a particular game at all. A side that runs well keeps its
   * own numbers where it has enough plays, and a defence moves them by
   * how much it gives up against what everybody gives up.
   */
  const byOffence = new Map<string, Counted>();
  const byDefence = new Map<string, Counted>();
  /**
   * And each man over everything he did on a call, with the league
   * beside him for comparison.
   *
   * Asking for his forty touches inside one widened state never found
   * them. The widening stops when the state has three hundred plays,
   * and the busiest man in such a state has thirty. So every carry and
   * every catch came out at the league's yards and no player differed
   * from any other, which is most of why the model moved a team game
   * by one point where what happened moves by ten.
   */
  const byMan = new Map<string, Rate>();
  const leagueOn = new Map<string, Rate>();
  /**
   * How often a throw for this many yards was caught.
   *
   * A gain above zero is nearly always a catch and a big loss is a
   * sack, but a zero is usually an incompletion and a small loss is
   * usually a screen brought down behind the line. Fitted from the
   * plays rather than asserted.
   */
  const caughtAt = new Map<number, { threw: number; caught: number }>();
  // how much of the ball each man took overall, so his usage at one
  // state can be read as a leaning rather than a level
  const overall = new Map<string, number>();
  const inScript = new Map<string, number>();
  const scriptPlays = new Map<string, number>();
  const onCall = new Map<string, number>();
  const callPlays = new Map<string, number>();
  let everyTouch = 0;
  const fromFormation = new Map<string, { plays: number; runs: number }>();
  /**
   * What a play from each formation came to, by call and by how far
   * out it was. A throw from under centre makes 8.13 yards and goes
   * twenty 14.5% of the time where one from the gun makes 6.58 and
   * goes twenty 8.8%, since the first is play action; a run from the
   * gun makes 5.04 against 4.67, since the box is lighter. The pools
   * keep none of this, so a side that lives in the gun draws the same
   * runs as one that never leaves centre.
   */
  const yardsFromFormation =
    new Map<string, { plays: number; yards: number; dry: number; long: number }>();
  /** the same with the shell the defence answered with */
  const againstLook =
    new Map<string, { plays: number; yards: number; dry: number }>();
  const formationBand = formationBandOf;

  for (const row of rows) {
    if (row.call === "pass" && row.caught !== undefined) {
      const band = Math.max(-8, Math.min(8, row.yards));
      const own = caughtAt.get(band) ?? { threw: 0, caught: 0 };
      own.threw++;
      if (row.caught) own.caught++;
      caughtAt.set(band, own);
    }

    if (row.player) {
      overall.set(row.player, (overall.get(row.player) ?? 0) + 1);
      everyTouch++;
      addTo(byMan, `${row.player}|${row.call}`, row.yards);
      addTo(leagueOn, row.call, row.yards);

      const script = scriptOf(row.margin, row.down, row.toGo);
      const inHere = `${script}|${row.call}`;
      inScript.set(
        `${inHere}|${row.player}`, (inScript.get(`${inHere}|${row.player}`) ?? 0) + 1,
      );
      scriptPlays.set(inHere, (scriptPlays.get(inHere) ?? 0) + 1);
      onCall.set(
        `${row.player}|${row.call}`,
        (onCall.get(`${row.player}|${row.call}`) ?? 0) + 1,
      );
      callPlays.set(row.call, (callPlays.get(row.call) ?? 0) + 1);
    }

    if (row.shotgun !== undefined) {
      // both keys, so a thin cell with the score in it can fall back
      // to the same spot with the score let go
      for (const at of [
        atFormation(
          row.shotgun, row.down, row.toGo, row.yardline,
          row.margin, row.secondsLeft,
        ),
        atFormation(row.shotgun, row.down, row.toGo, row.yardline),
      ]) {
        const seen = fromFormation.get(at) ?? { plays: 0, runs: 0 };
        seen.plays++;

        if (row.call === "run") {
          seen.runs++;
        }

        fromFormation.set(at, seen);
      }
      /**
       * And the same again with the defence's answer in it, which is
       * where the two calls stop ordering the shells the same way.
       */
      if (row.shell) {
        const pair = `${formationBand(row.call, row.shotgun, row.yardline)}|` +
          row.shell;
        const both = againstLook.get(pair) ??
          { plays: 0, yards: 0, dry: 0 };
        both.plays++;
        both.yards += row.yards;

        if (row.yards <= 0) {
          both.dry++;
        }

        againstLook.set(pair, both);
      }

      const band = formationBand(row.call, row.shotgun, row.yardline);
      const made = yardsFromFormation.get(band) ??
        { plays: 0, yards: 0, dry: 0, long: 0 };
      made.plays++;
      made.yards += row.yards;

      if (row.yards <= 0) {
        made.dry++;
      }

      if (row.yards >= 20) {
        made.long++;
      }

      yardsFromFormation.set(band, made);
    }
  }

  for (const row of rows) {
    // Keyed by the call as well. A run and a pass from the same spot
    // gain differently, 4.5 yards against 6.1 with a far fatter tail,
    // and go to different men. Pooling them meant the call decided
    // nothing at all.
    const at = `${row.call}|` + stateKey(
      row.down, row.toGo, row.yardline, row.secondsLeft, row.margin,
    );
    // and the same play again under any clock and any score, so a thin
    // state can fall back to the spot itself
    const loose = `${row.call}|${Math.min(4, row.down)}|${Math.min(40, row.toGo)}` +
      `|${Math.min(99, row.yardline)}|any`;
    // and once more without the call, because how often a side runs has
    // to come from one cell counting both. Widening a run pool and a
    // pass pool separately until each has enough finds eighty of each
    // wherever it must, and the answer is fifty percent every time.
    const eitherWay = stateKey(
      row.down, row.toGo, row.yardline, row.secondsLeft, row.margin,
    );
    const eitherLoose =
      `${Math.min(4, row.down)}|${Math.min(40, row.toGo)}` +
      `|${Math.min(99, row.yardline)}|any`;
    const cell = cells.get(at) ?? emptyCounted();
    cell.plays++;
    if (row.call === "run") cell.runs++;
    cell.yards.push(row.yards);
    cell.from.push(row.yardline);
    cell.scores += row.touchdown;

    if (row.call === "pass" && row.airYards !== undefined) {
      const band = bandOf(row.airYards);
      cell.byDepth.set(band, [...(cell.byDepth.get(band) ?? []), row.yards]);
      cell.byDepthFrom.set(
        band, [...(cell.byDepthFrom.get(band) ?? []), row.yardline],
      );
    }

    if (row.player) {
      countIn(cell.named, row.yards);
      const own = cell.byPlayer.get(row.player) ??
        { touches: 0, yards: 0, scores: 0, long: 0 };
      own.touches++;
      own.yards += row.yards;
      own.scores += row.touchdown;
      if (row.yards >= 20) own.long++;
      cell.byPlayer.set(row.player, own);
    }

    cells.set(at, cell);

    const anyTime = cells.get(loose) ?? emptyCounted();
    anyTime.plays++;
    if (row.call === "run") anyTime.runs++;
    anyTime.yards.push(row.yards);
    anyTime.from.push(row.yardline);
    anyTime.scores += row.touchdown;

    if (row.call === "pass" && row.airYards !== undefined) {
      const band = bandOf(row.airYards);
      anyTime.byDepth.set(band, [...(anyTime.byDepth.get(band) ?? []), row.yards]);
      anyTime.byDepthFrom.set(
        band, [...(anyTime.byDepthFrom.get(band) ?? []), row.yardline],
      );
    }

    if (row.player) {
      countIn(anyTime.named, row.yards);
      const own = anyTime.byPlayer.get(row.player) ??
        { touches: 0, yards: 0, scores: 0, long: 0 };
      own.touches++;
      own.yards += row.yards;
      own.scores += row.touchdown;
      if (row.yards >= 20) own.long++;
      anyTime.byPlayer.set(row.player, own);
    }

    cells.set(loose, anyTime);

    for (const key of [eitherWay, eitherLoose]) {
      const both = cells.get(key) ?? emptyCounted();
      both.plays++;
      if (row.call === "run") both.runs++;
      cells.set(key, both);
    }

    /**
     * And the same two cells again with the formation on the front,
     * so the call from a known formation is asked of the same states
     * and widened the same way as the call from the mixture. A table
     * of its own, keyed on yardline deciles, came out a point and a
     * bit under what the plays did.
     */
    if (row.shotgun !== undefined) {
      const form = row.shotgun ? "gun" : "centre";
      /**
       * Older seasons count for less here, which they do nowhere
       * else. How often a side runs at all has been flat for years,
       * so pooling seasons costs the pooled call nothing; how often
       * it runs from a given formation has not. Sides ran from the
       * gun 27.0% of the time in 2021 and 30.6% in 2023, and they
       * lined up in it 66% then and 72% now, so a flat pool of three
       * seasons asks a point and a bit under what the plays did, and
       * that is the whole of what the formation call was losing.
       */
      const counts = freshest && row.season
        ? FORM_FADES[Math.min(5, freshest - row.season)]!
        : 1;

      for (const key of [eitherWay, eitherLoose]) {
        const both = cells.get(`${form}|${key}`) ?? emptyCounted();
        both.plays += counts;
        if (row.call === "run") both.runs += counts;
        cells.set(`${form}|${key}`, both);
      }
    }

    for (const [into, who] of wantsSides
      ? [[byOffence, row.offence], [byDefence, row.defence]] as
          [Map<string, Counted>, string][]
      : []) {
      if (!who) {
        continue;
      }

      for (const key of [`${who}|${at}`, `${who}|${loose}`, `${who}|${eitherLoose}`]) {
        const side = into.get(key) ?? emptyCounted();
        side.plays++;
        if (row.call === "run") side.runs++;
        side.yards.push(row.yards);
        side.scores += row.touchdown;
        into.set(key, side);
      }
    }
  }
  return {
    cells, byOffence, byDefence, byMan, leagueOn, caughtAt, overall,
    everyTouch, inScript, scriptPlays, onCall, callPlays, fromFormation,
    yardsFromFormation,
    againstLook,
  };
}

export function fitPlayFactors(
  rows: PlayRow[],
  settings: FactorSettings = FACTOR_DEFAULTS,
  extras: FactorExtras = {},
): PlayFactors {
  const {
    projected, split, pairing, playLevel, depth, people, plays,
    alike, formation, coverage, look, afterCatch,
  } = extras;
  const {
    cells, byOffence, byDefence, byMan, leagueOn, caughtAt, overall,
    everyTouch, inScript, scriptPlays, onCall, callPlays,
    fromFormation = new Map<string, { plays: number; runs: number }>(),
    yardsFromFormation = new Map<
      string, { plays: number; yards: number; dry: number; long: number }
    >(),
    againstLook = new Map<
      string, { plays: number; yards: number; dry: number }
    >(),
  } = extras.counted ?? countPlays(rows, !pairing);

  /**
   * What this side's habit does to a drawn gain, near one. The pools
   * hold the league's mixture of formations, so a side that lives in
   * the gun should draw runs a little longer and throws a little
   * shorter than the mixture, and one that never leaves centre the
   * other way. Centred on the league's own mix, so a side with no
   * habit of its own moves nothing.
   */
  /**
   * What the shell the defence answered with does to a play from this
   * formation, against what that formation comes to on average. The
   * two calls do not order the shells the same way, so this is the
   * pair rather than a defence being stout or not.
   */
  const lookTilt = (
    state: PlayState, call: Call, shotgun: boolean, shell?: string,
  ) => {
    if (!shell || againstLook.size === 0) {
      return 1;
    }

    const band = formationBandOf(call, shotgun, state.yardline);
    const both = againstLook.get(`${band}|${shell}`);
    const anyLook = yardsFromFormation.get(band);

    if (!both || !anyLook || both.plays < 200 || anyLook.plays < 200) {
      return 1;
    }

    const its = both.yards / both.plays;
    const usual = anyLook.yards / anyLook.plays;

    return usual > 0.1 ? Math.max(0.75, Math.min(1.35, its / usual)) : 1;
  };

  /**
   * What a play from the formation the side stood in comes to,
   * against what that call comes to over both. Drawn now rather than
   * taken as the side's habit, so the gain answers to the same snap
   * the call did.
   */
  const drawnFormationTilt = (
    state: PlayState, call: Call, shotgun?: boolean,
  ) => {
    if (shotgun === undefined || yardsFromFormation.size === 0) {
      return 1;
    }

    const its = yardsFromFormation.get(
      formationBandOf(call, shotgun, state.yardline),
    );
    const other = yardsFromFormation.get(
      formationBandOf(call, !shotgun, state.yardline),
    );

    if (!its || !other || its.plays < 200 || other.plays < 200) {
      return 1;
    }

    const mixture = (its.yards + other.yards) /
      Math.max(1, its.plays + other.plays);

    return mixture > 0.1
      ? Math.max(0.75, Math.min(1.35, (its.yards / its.plays) / mixture))
      : 1;
  };

  /**
   * What he makes once the ball is his. A catch is near enough half
   * throw and half after it, and the two are different skills, so
   * only the second half moves with the man.
   */
  const afterCatchTilt = (call: Call, player: string) => {
    if (!afterCatch || call !== "pass" || !player) {
      return 1;
    }

    const lean = afterCatch.leanOf(player);

    return 1 + (lean - 1) * afterCatch.shareAfter;
  };

  const formationTilt = (state: PlayState, call: Call, offence?: string) => {
    if (!formation || !offence || yardsFromFormation.size === 0) {
      return 1;
    }

    const inGun = yardsFromFormation.get(
      formationBandOf(call, true, state.yardline),
    );
    const centre = yardsFromFormation.get(
      formationBandOf(call, false, state.yardline),
    );

    if (!inGun || !centre || inGun.plays < 200 || centre.plays < 200) {
      return 1;
    }

    const gunYards = inGun.yards / inGun.plays;
    const centreYards = centre.yards / centre.plays;
    const leagueGun = inGun.plays / (inGun.plays + centre.plays);
    const his = Math.max(0.02, Math.min(0.98,
      leagueGun * formation.leaning(offence)));
    const mixture = leagueGun * gunYards + (1 - leagueGun) * centreYards;
    const hisWay = his * gunYards + (1 - his) * centreYards;

    return mixture > 0.1
      ? Math.max(0.85, Math.min(1.2, hisWay / mixture))
      : 1;
  };

  /**
   * How much more of the work a man takes when the game is going this
   * way than he takes on that call in general.
   *
   * Trailing teams throw to their best receiver and stop handing off,
   * and a third and long belongs to whoever can win it. His own
   * numbers are pulled toward taking no view until he has been in the
   * situation enough, since a man with nine catches while behind
   * should not have his afternoon decided by them.
   */
  const scriptLeaning = (player: string, call: Call, state: PlayState) => {
    const script = scriptOf(state.margin, state.down, state.toGo);
    const here = inScript.get(`${script}|${call}|${player}`) ?? 0;
    const anybodyHere = scriptPlays.get(`${script}|${call}`) ?? 0;
    const his = onCall.get(`${player}|${call}`) ?? 0;
    const anybody = callPlays.get(call) ?? 0;

    if (!here || !anybodyHere || !his || !anybody) {
      return 1;
    }

    const leaning = (here / anybodyHere) / (his / anybody);
    const trust = here / (here + 40);

    return trust * leaning + (1 - trust);
  };

  /**
   * The states around this one, taken until there are enough plays.
   *
   * The clock and the score are held first, and if this spot cannot
   * answer for itself under them the whole thing starts again with them
   * let go. Carrying the tight counts into the loose pass would add the
   * any-time cells on top of them, and those contain the tight ones, so
   * the game situation would be swamped every time.
   */
  const gather = (
    state: PlayState, least: number, looseness: number, call?: Call,
  ) => {
    const pooled = emptyCounted();

    for (const packed of wideningPacked(state.toGo, state.yardline)) {
      if (Math.floor(packed / 100000) !== looseness) {
        continue;
      }

      for (const at of keysAt(
        state.down, Math.floor(packed / 100) % 1000, packed % 100,
        state.secondsLeft, state.margin, looseness,
      )) {
      const cell = cells.get(call ? `${call}|${at}` : at);

      if (!cell) {
        continue;
      }

      pooled.plays += cell.plays;
      pooled.runs += cell.runs;
      pooled.scores += cell.scores;
      // pushed rather than concatenated: rebuilding the array at every
      // spot makes the gather quadratic, and a game that plays out
      // asks for far more distinct states than one that does not
      for (const gained of cell.yards) pooled.yards.push(gained);
      for (const spot of cell.from) pooled.from.push(spot);
      for (const [band, gains] of cell.byDepth) {
        const already = pooled.byDepth.get(band) ?? [];
        for (const gained of gains) already.push(gained);
        pooled.byDepth.set(band, already);
        // in step with the gains above, so the room filter still lines
        // up after several cells have been gathered into one
        const spots = pooled.byDepthFrom.get(band) ?? [];
        for (const spot of cell.byDepthFrom.get(band) ?? []) spots.push(spot);
        pooled.byDepthFrom.set(band, spots);
      }

      pooled.named.touches += cell.named.touches;
      pooled.named.yards += cell.named.yards;
      pooled.named.long += cell.named.long;

      for (const [player, own] of cell.byPlayer) {
        const already = pooled.byPlayer.get(player) ??
          { touches: 0, yards: 0, scores: 0, long: 0 };
        already.touches += own.touches;
        already.yards += own.yards;
        already.scores += own.scores;
        already.long += own.long;
        pooled.byPlayer.set(player, already);
      }

      }

      if (pooled.plays >= least) {
        break;
      }
    }

    return pooled;
  };

  /**
   * The same gathering over one side's own plays. Kept apart from the
   * league version so a thin team falls back to everybody rather than
   * quietly mixing the two.
   */
  /** each cell's yards added up once, since the array never changes */
  const cellSums = new WeakMap<Counted, number>();
  const summedOnce = (cell: Counted) => {
    const already = cellSums.get(cell);

    if (already !== undefined) {
      return already;
    }

    const sum = cell.yards.reduce((a, b) => a + b, 0);
    cellSums.set(cell, sum);

    return sum;
  };
  const sideRemembered = new Map<string, {
    plays: number; runs: number; yardsSum: number;
    leaguePlays: number; leagueRuns: number;
  }>();
  const forgetsAt = () => makeRoom(sideRemembered);
  const forSide = (
    from: Map<string, Counted>, who: string, state: PlayState,
    least: number, call?: Call,
  ) => {
    forgetsAt();
    const key = `${who}|${call ?? "both"}|${stateKey(
      state.down, state.toGo, state.yardline, state.secondsLeft, state.margin,
    )}|${least}`;
    const already = sideRemembered.get(key);

    if (already) {
      return already;
    }

    /**
     * Sums only. This used to copy every yard of a side's pooled cells
     * into a fresh array three times a play, and once the per side
     * counts were connected those cells held whole team seasons. The
     * two callers want a rate and an average, so the numbers travel
     * and the arrays stay where they are.
     */
    /**
     * The league is summed over the same cells the side's own plays
     * came from. A side rarely has sixty plays at one score and clock,
     * so its pool widens past them, and a rate read there can only be
     * compared against the league read there too. Comparing it against
     * the league's tight pool mixed the any-score team mix into the
     * situation and pulled every extreme spot toward the middle.
     */
    let found = { plays: 0, runs: 0, yardsSum: 0, leaguePlays: 0, leagueRuns: 0 };

    for (const looseness of [0, 1, 2]) {
      const pooled = { plays: 0, runs: 0, yardsSum: 0, leaguePlays: 0, leagueRuns: 0 };

      for (const packed of wideningPacked(state.toGo, state.yardline)) {
        if (Math.floor(packed / 100000) !== looseness) {
          continue;
        }

        for (const cellKey of keysAt(
          state.down, Math.floor(packed / 100) % 1000, packed % 100,
          state.secondsLeft, state.margin, looseness,
        )) {
          const cell = from.get(`${who}|${call ? `${call}|${cellKey}` : cellKey}`);

          if (!cell) {
            continue;
          }

          pooled.plays += cell.plays;
          pooled.runs += cell.runs;
          pooled.yardsSum += summedOnce(cell);
          const everybody = cells.get(call ? `${call}|${cellKey}` : cellKey);

          if (everybody) {
            pooled.leaguePlays += everybody.plays;
            pooled.leagueRuns += everybody.runs;
          }
        }

        if (pooled.plays >= least) {
          break;
        }
      }

      found = pooled;

      if (found.plays >= least) {
        break;
      }
    }

    sideRemembered.set(key, found);
    return found;
  };

  const average = (cell: { plays: number; yardsSum: number }) =>
    cell.plays === 0 ? 0 : cell.yardsSum / cell.plays;

  /**
   * Remembering every widened lookup was fine while every drive was
   * asked about at nil apiece with half the clock left, which is a
   * few thousand keys. A game played out sweeps the clock and the
   * score, which is hundreds of thousands, each holding a pooled cell
   * of arrays, and the cache became the reason long runs died at
   * eight gigabytes. Letting it go now and then keeps the speed where
   * the same states repeat and the memory flat.
   */
  const REMEMBERS = Number(process.env["REMEMBERS"] ?? 30000);
  const remembered = new Map<string, Counted>();
  /**
   * Half goes rather than all of it: clearing everything made every
   * following lookup a fresh gather, and a map iterates in insertion
   * order, so dropping the older half keeps what the walk is asking
   * about right now.
   */
  const makeRoom = (cache: Map<string, unknown>) => {
    if (cache.size <= REMEMBERS) {
      return;
    }

    let toGo = cache.size >> 1;

    for (const key of cache.keys()) {
      if (toGo-- <= 0) {
        break;
      }

      cache.delete(key);
    }
  };
  /**
   * How far a pool had to widen before it filled. A pool that only
   * filled with the score let go has lost the game situation, and the
   * caller that draws gains from it puts the situation back as a
   * ratio.
   */
  const settledAt = new WeakMap<Counted, number>();
  const at = (state: PlayState, least: number, call?: Call) => {
    makeRoom(remembered);
    const key = `${call ?? "both"}|${stateKey(
      state.down, state.toGo, state.yardline, state.secondsLeft, state.margin,
    )}|${least}`;
    const already = remembered.get(key);

    if (already) {
      return already;
    }

    let found = gather(state, least, 0, call);
    settledAt.set(found, 0);

    for (const looseness of [1, 2]) {
      if (found.plays >= least) {
        break;
      }

      found = gather(state, least, looseness, call);
      settledAt.set(found, looseness);
    }
    remembered.set(key, found);
    return found;
  };

  /**
   * What this game situation does to a play's yards, against the
   * any-score pool the draw came from.
   *
   * The gains pool needs three hundred plays and almost never finds
   * them with the score and clock held, so late-game draws come from
   * the any-score pool and a side up two scores gains like a side
   * playing level. Really it gains 4.80 a play where the level side
   * gains 5.41: the leader runs into a set front and takes what is
   * underneath. A mean over the situation's own cells needs far
   * fewer plays than a distribution does, so it can keep the score
   * conditioning where the pool could not.
   */
  /** each cell's plays that made nothing, counted once */
  const cellDry = new WeakMap<Counted, number>();
  const driedOnce = (cell: Counted) => {
    const already = cellDry.get(cell);

    if (already !== undefined) {
      return already;
    }

    let dry = 0;

    for (const gained of cell.yards) {
      if (gained <= 0) {
        dry++;
      }
    }

    cellDry.set(cell, dry);

    return dry;
  };
  const situationRemembered = new Map<string, { gain: number; dry: number }>();
  const situationTilt = (state: PlayState, call: Call) => {
    makeRoom(situationRemembered);
    const key = `${call}|${stateKey(
      state.down, state.toGo, state.yardline, state.secondsLeft, state.margin,
    )}`;
    const already = situationRemembered.get(key);

    if (already !== undefined) {
      return already;
    }

    const sums = (looseCap: number) => {
      let found = { plays: 0, yardsSum: 0, dry: 0 };

      for (const looseness of looseCap === 2 ? [2] : [0, 1]) {
        if (found.plays >= settings.leastForSide) {
          break;
        }

        const pooled = { plays: 0, yardsSum: 0, dry: 0 };

        for (const packed of wideningPacked(state.toGo, state.yardline)) {
          if (Math.floor(packed / 100000) !== looseness) {
            continue;
          }

          for (const cellKey of keysAt(
            state.down, Math.floor(packed / 100) % 1000, packed % 100,
            state.secondsLeft, state.margin, looseness,
          )) {
            const cell = cells.get(`${call}|${cellKey}`);

            if (!cell) {
              continue;
            }

            pooled.plays += cell.plays;
            pooled.yardsSum += summedOnce(cell);
            pooled.dry += driedOnce(cell);
          }

          if (pooled.plays >= settings.leastForSide) {
            break;
          }
        }

        found = pooled;
      }

      return found;
    };
    const held = sums(1);
    const wide = sums(2);

    /**
     * The dry share moves separately at the draw, so the gain ratio is
     * taken over the plays that made something on each side, or the
     * two would count the same difference twice.
     */
    const enough = held.plays >= settings.leastForSide && wide.plays > 0;
    const heldDry = enough ? held.dry / held.plays : 0;
    const wideDry = enough ? wide.dry / wide.plays : 0;
    const heldGainful = heldDry < 0.99
      ? (held.yardsSum / Math.max(1, held.plays)) / (1 - heldDry)
      : 0;
    const wideGainful = wideDry < 0.99
      ? (wide.yardsSum / Math.max(1, wide.plays)) / (1 - wideDry)
      : 0;
    const tilt = {
      gain: enough && wideGainful > 0.1 && heldGainful > 0
        ? Math.max(0.8, Math.min(1.25, heldGainful / wideGainful))
        : 1,
      dry: enough && wideDry > 0.01
        ? Math.max(0.8, Math.min(1.25, heldDry / wideDry))
        : 1,
    };
    situationRemembered.set(key, tilt);

    return tilt;
  };

  /**
   * The same widening walk, keeping only what its caller reads.
   *
   * The full gather merges every cell's player map, and the run rate
   * wants two numbers while the share split wants twelve players out
   * of hundreds. These two walked the same cells and carried the whole
   * merge, which was 95% of a game's cost.
   */
  const countsRemembered =
    new Map<string, { plays: number; runs: number; scores: number }>();
  /**
   * The two formations counted over one widening pass, so they stand
   * on the same states. Widening them apart put the gun and the
   * centre on different supports, and a ratio between those is not a
   * leaning, it is two answers to different questions.
   */
  const bothFormsRemembered = new Map<string, {
    gun: { plays: number; runs: number };
    centre: { plays: number; runs: number };
  }>();
  const atBothForms = (state: PlayState, least: number) => {
    makeRoom(bothFormsRemembered);
    const key = `${stateKey(
      state.down, state.toGo, state.yardline, state.secondsLeft, state.margin,
    )}|${least}`;
    const already = bothFormsRemembered.get(key);

    if (already) {
      return already;
    }

    let found = {
      gun: { plays: 0, runs: 0 }, centre: { plays: 0, runs: 0 },
    };

    for (const looseness of [0, 1, 2]) {
      if (found.gun.plays + found.centre.plays >= least) {
        break;
      }

      const pooled = {
        gun: { plays: 0, runs: 0 }, centre: { plays: 0, runs: 0 },
      };

      for (const packed of wideningPacked(state.toGo, state.yardline)) {
        if (Math.floor(packed / 100000) !== looseness) {
          continue;
        }

        for (const cellKey of keysAt(
          state.down, Math.floor(packed / 100) % 1000, packed % 100,
          state.secondsLeft, state.margin, looseness,
        )) {
          for (const form of ["gun", "centre"] as const) {
            const cell = cells.get(`${form}|${cellKey}`);

            if (cell) {
              pooled[form].plays += cell.plays;
              pooled[form].runs += cell.runs;
            }
          }
        }

        if (pooled.gun.plays + pooled.centre.plays >= least) {
          break;
        }
      }

      found = pooled;
    }

    bothFormsRemembered.set(key, found);

    return found;
  };

  const atCounts = (
    state: PlayState, least: number, call?: Call,
    /**
     * The formation the side stood in, when the walk has drawn one.
     * The cells carry it, so the same widening serves it: a coarse
     * table of its own read the call off yardline deciles and came
     * out a point and a bit under what the plays did.
     */
    form?: string,
  ) => {
    makeRoom(countsRemembered);
    const key = `${form ?? ""}|${call ?? "both"}|${stateKey(
      state.down, state.toGo, state.yardline, state.secondsLeft, state.margin,
    )}|${least}`;
    const already = countsRemembered.get(key);

    if (already) {
      return already;
    }

    let found = { plays: 0, runs: 0, scores: 0 };

    for (const looseness of [0, 1, 2]) {
      if (found.plays >= least) {
        break;
      }

      const pooled = { plays: 0, runs: 0, scores: 0 };

      for (const packed of wideningPacked(state.toGo, state.yardline)) {
        if (Math.floor(packed / 100000) !== looseness) {
          continue;
        }

        for (const cellKey of keysAt(
          state.down, Math.floor(packed / 100) % 1000, packed % 100,
          state.secondsLeft, state.margin, looseness,
        )) {
          const spot = call ? `${call}|${cellKey}` : cellKey;
          const cell = cells.get(form ? `${form}|${spot}` : spot);

          if (!cell) {
            continue;
          }

          pooled.plays += cell.plays;
          pooled.runs += cell.runs;
          pooled.scores += cell.scores;
        }

        if (pooled.plays >= least) {
          break;
        }
      }

      found = pooled;
    }

    countsRemembered.set(key, found);

    return found;
  };

  const crossRemembered = new Map<string, number>();
  const cellsRemembered = new Map<string, Counted[]>();
  const atCells = (state: PlayState, least: number, call?: Call) => {
    makeRoom(cellsRemembered);
    const key = `${call ?? "both"}|${stateKey(
      state.down, state.toGo, state.yardline, state.secondsLeft, state.margin,
    )}|${least}`;
    const already = cellsRemembered.get(key);

    if (already) {
      return already;
    }

    let found: Counted[] = [];
    let plays = 0;

    for (const looseness of [0, 1, 2]) {
      if (plays >= least) {
        break;
      }

      const pooled: Counted[] = [];
      plays = 0;

      for (const packed of wideningPacked(state.toGo, state.yardline)) {
        if (Math.floor(packed / 100000) !== looseness) {
          continue;
        }

        for (const cellKey of keysAt(
          state.down, Math.floor(packed / 100) % 1000, packed % 100,
          state.secondsLeft, state.margin, looseness,
        )) {
          const cell = cells.get(call ? `${call}|${cellKey}` : cellKey);

          if (!cell) {
            continue;
          }

          pooled.push(cell);
          plays += cell.plays;
        }

        if (plays >= least) {
          break;
        }
      }

      found = pooled;
    }

    cellsRemembered.set(key, found);

    return found;
  };

  /** each cell's touches added up once, since the map never changes */
  const cellTouches = new WeakMap<Counted, number>();
  const touchesOf = (cell: Counted) => {
    const already = cellTouches.get(cell);

    if (already !== undefined) {
      return already;
    }

    let sum = 0;

    for (const own of cell.byPlayer.values()) {
      sum += own.touches;
    }

    cellTouches.set(cell, sum);

    return sum;
  };

  /**
   * What the level averages over the touches it is put on.
   *
   * A man's level is his yards against the league's, and the men who
   * get the ball are better than the average of everyone who ever
   * touched it, so the levels average above one and every play comes
   * out long. Asked about the plays a season really had, the walk
   * gained 4.66 on a carry against the 4.50 sides managed and 7.68 on
   * a throw against 7.32. Dividing by what it averages puts the level
   * back where it belongs and leaves what separates two men alone.
   */
  const centreOf = new Map<string, number>();

  for (const call of ["run", "pass"] as Call[]) {
    const league = leagueOn.get(call);

    if (!league || league.touches <= 0) {
      continue;
    }

    const middle = league.yards / league.touches;
    const leagueLong = league.long / Math.max(1, league.touches);
    let weighted = 0;
    let touches = 0;

    for (const [key, his] of byMan) {
      if (!key.endsWith(`|${call}`) || his.touches < settings.leastForMan) {
        continue;
      }

      const hisLong = his.long / Math.max(1, his.touches);
      const level = (his.yards / his.touches) / Math.max(0.1, middle);
      const shape = leagueLong > 0 && hisLong > 0
        ? level * (leagueLong / hisLong) ** 0.5
        : level;
      weighted += Math.max(0.5, Math.min(1.8, shape)) * his.touches;
      touches += his.touches;
    }

    if (touches > 0) {
      centreOf.set(call, weighted / touches);
    }
  }

  const wasCaught = (gained: number, uniform: () => number) => {
    const own = caughtAt.get(Math.max(-8, Math.min(8, Math.round(gained))));

    if (!own || own.threw < 50) {
      return gained > 0;
    }

    return uniform() < own.caught / own.threw;
  };

  /**
   * His own plays at spots like this one, widened over the state in
   * three passes: same down and near distance, then any down with the
   * field alike, then everything he has done on this call. Room to
   * run is asked of the pool the same way the pooled path asks it.
   */
  /** widened play lists, one per man and call, built once */
  const pooled = new Map<string, number[]>();

  const hisOwnPlay = plays
    ? (
        state: PlayState, call: Call, player: string, uniform: () => number,
        passer?: string,
        sides?: {
          offence?: string; defence?: string;
          passer?: string; season?: number; week?: number;
          shotgun?: boolean; shell?: string;
        },
      ) => {
        /**
         * A sack or a ball thrown away first, since one belongs to no
         * receiver and so is in nobody's pool. A tenth of throws are
         * one of these, and without them the walk's drives travelled a
         * third further than a side's do.
         */
        if (call === "pass" && plays.wasted.length &&
            uniform() < plays.wastedShareAt(state.yardline)) {
          const near = plays.wasted.filter(
            (w) => Math.abs(w.yardline - state.yardline) <= 15,
          );
          const from = near.length >= 100 ? near : plays.wasted;

          return {
            yards: from[Math.floor(uniform() * from.length)]!.yards,
            caught: false,
          };
        }

        /**
         * A throw between these exact two men first, when they have
         * enough between them. The pairing the multiplier interface
         * could never carry comes out of joint sampling instead: what
         * Chase does with Burrow throwing is what those plays were.
         */
        const poolKey = `${player}|${passer ?? ""}|${call}`;
        let his = pooled.get(poolKey);

        if (!his) {
          const together = call === "pass" && passer
            ? plays.ofPair.get(`${player}|${passer}`) ?? []
            : [];
          his = together.length >= 25
            ? together
            : plays.ofMan.get(`${player}|${call}`) ?? [];

          if (his.length < 25 && alike) {
            for (const twin of alike.get(player) ?? []) {
              his = his.concat(plays.ofMan.get(`${twin}|${call}`) ?? []);

              if (his.length >= 60) {
                break;
              }
            }
          }

          pooled.set(poolKey, his);
        }

        if (his.length < 25) {
          return undefined;
        }

        /**
         * How far out a play may have been made and still stand in for
         * one here. Inside the twenty this used to be a flat ten yards
         * at every pass, and hardly anybody has twenty of his own plays
         * from inside the thirty, so the draw gave up on 70% of throws
         * inside the ten and fell back to the pooled one, which gains
         * 4.62 where a targeted throw gains 7.33. That is where the
         * walk's short goal line came from.
         */
        const passes: { fits: (i: number) => boolean; room: number }[] = [
          {
            fits: (i) => plays.down[i] === state.down &&
              Math.abs(plays.toGo[i]! - state.toGo) <= 3 &&
              Math.abs(plays.yardline[i]! - state.yardline) <= 20,
            room: 10,
          },
          {
            fits: (i) => Math.abs(plays.yardline[i]! - state.yardline) <= 25,
            room: 20,
          },
          { fits: () => true, room: 35 },
        ];

        // counted then scanned rather than filtered into an array,
        // which is the walk's hottest line and was allocating a pool
        // for every play of every game
        for (const { fits, room } of passes) {
          const wanted = (i: number) =>
            fits(i) &&
            (state.yardline > NEAR_GOAL ||
              (plays.yardline[i]! <= state.yardline + room &&
                plays.yardline[i]! >= state.yardline - CLOSER)) &&
            (state.yardline <= NEAR_GOAL ||
              plays.yardline[i]! >= state.yardline - FIELD_CLOSER);
          let count = 0;
          let weight = 0;
          let crossedWeight = 0;
          let dryWeight = 0;

          for (const i of his) {
            if (wanted(i)) {
              count++;
              const w = FADES[plays.age[i]!] ?? FADES[5]!;
              weight += w;

              if (plays.yards[i]! >= state.yardline) {
                crossedWeight += w;
              }

              if (plays.yards[i]! <= 0) {
                dryWeight += w;
              }
            }
          }

          if (count < 20) {
            continue;
          }

          let left = uniform() * weight;
          let at = his[0]!;

          for (const i of his) {
            if (wanted(i)) {
              left -= FADES[plays.age[i]!] ?? FADES[5]!;

              if (left <= 0) {
                at = i;
                break;
              }
            }
          }

          // his sample crosses the goal more often than plays from
          // this state score, so the surplus is put down at the one
          if (state.yardline <= 20 && plays.yards[at]! >= state.yardline &&
              crossedWeight > 0) {
            const counted = atCounts(state, settings.leastForSide, call);
            const scoreRate = counted.plays === 0
              ? crossedWeight / weight
              : counted.scores / counted.plays;
            const keeps = Math.min(1, scoreRate / (crossedWeight / weight));

            if (uniform() >= keeps) {
              return {
                yards: Math.max(0, state.yardline - 1),
                caught: plays.caught[at] === 1,
              };
            }
          }

          /**
           * His own plays come from every game situation he ever
           * faced, so the score and the clock are put back the same
           * way the pooled draw puts them back: a side milking a lead
           * gains less on the same call, and his sample cannot know.
           */
          const tilt = situationTilt(state, call);
          const drawn = plays.yards[at]!;

          /**
           * The level model, on the sampled path as well.
           *
           * His own plays were made against everybody he ever faced,
           * so this week's people have to be heard here too, and the
           * pooled path is the only one that used to hear them. That
           * is why the model read as a wash: a starter has plays of
           * his own, so the pooled path is where he never goes.
           */
          if (playLevel && sides) {
            const dryHere = dryWeight / Math.max(1, weight);
            const stuffs = playLevel.stuffedBy(state, call, player, sides);

            if (drawn > 0 && stuffs > 1 && dryHere < 0.95) {
              const goesDry = (stuffs - 1) * dryHere / (1 - dryHere);

              if (uniform() < goesDry) {
                return { yards: 0, caught: false };
              }
            }

            if (drawn > 0) {
              const level = playLevel.levelFor(state, call, player, sides);

              return {
                yards: Math.min(state.yardline,
                  drawn * tilt.gain * Math.max(0.5, Math.min(1.8, level))),
                caught: plays.caught[at] === 1,
              };
            }
          }

          const byFormation = sides?.shotgun !== undefined
            ? drawnFormationTilt(state, call, sides.shotgun)
            : formationTilt(state, call, sides?.offence);
          const byLook = lookTilt(
            state, call, sides?.shotgun ?? false, sides?.shell,
          );

          return {
            yards: Math.min(state.yardline,
              drawn > 0
                ? drawn * tilt.gain * byFormation * byLook *
                  afterCatchTilt(call, player)
                : drawn),
            caught: plays.caught[at] === 1,
          };
        }

        return undefined;
      }
    : undefined;

  return {
    /**
     * The snap settled before the call, which is how football works
     * and measures worse: every drawn layer adds variance, and a
     * week of a man's scoring orders at .314 this way against .343
     * with the side's habit applied to the gain and nothing drawn.
     * Behind SNAP_CHAIN until something makes the layers pay.
     */
    /**
     * How often this side is in the gun here, off the very cells the
     * call is then priced from. Reading it off a coarser table drew
     * the gun at one rate and priced the call at another, which is
     * why the mix came out four points light on the run.
     */
    standsBack: process.env["SNAP_CHAIN"] && formation
      ? (state, offence) => {
          const inGun = atCounts(state, settings.leastForCall, undefined, "gun");
          const centre =
            atCounts(state, settings.leastForCall, undefined, "centre");

          if (inGun.plays + centre.plays < 200) {
            return formation.gunHere(state, offence);
          }

          const here = inGun.plays / (inGun.plays + centre.plays);

          return Math.max(0.02, Math.min(0.98,
            here * formation.leaning(offence)));
        }
      : undefined,
    looksLike: process.env["SNAP_CHAIN"] && look
      ? (state, shotgun, defence, uniform) =>
          look.shellFor(state, shotgun, defence, uniform)
      : undefined,
    hisOwnPlay,
    matchup: pairing,
    caught: wasCaught,
    runs: (state, offence, sides) => {
      const league = atCounts(state, settings.leastForCall);
      const leagueRate = league.plays === 0 ? 0.45 : league.runs / league.plays;

      /**
       * The formation first, then the call from it. A side in the gun
       * runs 41.7% on first and ten between the twenties and one
       * under centre runs 67.7%, and where a side stands is more its
       * own from season to season than any rate it puts up. Averaging
       * over both is how the call lost the side that was making it.
       */
      /**
       * The call from the formation is off: the pools already carry
       * how much this side runs, read straight off its own plays at
       * these cells, so drawing the formation first says the same
       * thing twice and pays for it in noise. What the formation
       * knows that the pools do not is what a play from it comes to,
       * and that is applied to the gains instead.
       */
      /**
       * The call from the formation the side actually stood in. This
       * was redundant while the formation went nowhere else, and it
       * is not now: the gain is drawn against the same formation, so
       * a play under centre has to be called like one.
       */
      if (sides?.shotgun !== undefined) {
        const wants = Number(process.env["FORM_LEAST"] ?? settings.leastForCall);
        const both = atBothForms(state, wants);
        const here = sides.shotgun ? both.gun : both.centre;
        const other = sides.shotgun ? both.centre : both.gun;

        /**
         * The formation as a leaning on the pooled rate, not a rate of
         * its own. Its own rate carries whatever the older seasons
         * ran, and that has moved: sides ran from the gun 27.0% of the
         * time in 2021 and 30.6% in 2023 while how often they ran at
         * all stayed flat. A ratio against the same cells' mixture
         * keeps the level where the pools have it and takes only what
         * the formation says.
         */
        if (here.plays > 0 && other.plays > 0) {
          const mine = here.runs / here.plays;
          const mixture = (here.runs + other.runs) /
            (here.plays + other.plays);

          if (mixture > 0.01) {
            /**
             * As a leaning it is better calibrated and orders worse:
             * it asks 41.2% where the plays were 41.8% against 40.5%
             * for the rate, and a week of a man reads .327 against
             * .336. Pulling toward the pooled level takes the
             * formation back out of the call.
             */
            return process.env["FORM_LEAN"]
              ? Math.max(0.02, Math.min(0.98, leagueRate * (mine / mixture)))
              : Math.max(0.02, Math.min(0.98, mine));
          }
        }
      }

      if (formation && fromFormation.size > 0 && process.env["FORMATION_CALL"]) {
        const inGun = fromFormation.get(
          atFormation(true, state.down, state.toGo, state.yardline),
        );
        const underCentre = fromFormation.get(
          atFormation(false, state.down, state.toGo, state.yardline),
        );

        if (inGun && underCentre &&
            inGun.plays >= settings.leastForCall &&
            underCentre.plays >= settings.leastForCall) {
          /**
           * The league's own rate at these very cells, so a side with
           * no leaning of its own comes out exactly where the pools
           * had it. Taking the base from a differently cut table
           * passed 1.8 points more than the plays did.
           */
          const here = inGun.plays / (inGun.plays + underCentre.plays);
          const gun = Math.max(0.02, Math.min(0.98,
            here * formation.leaning(offence)));

          return Math.max(0.02, Math.min(0.98,
            gun * (inGun.runs / inGun.plays) +
            (1 - gun) * (underCentre.runs / underCentre.plays)));
        }
      }

      /**
       * The model's own read of the call, where it has one. The pools
       * see the down, the distance and the spot; the model can also
       * see the staff calling it and the men the defence has on the
       * field, and both are things a run rate really turns on.
       */
      const said = playLevel?.runsHere && sides
        ? playLevel.runsHere(state, sides)
        : undefined;

      /**
       * At nothing, because the pools win this one and win it by a
       * lot: weekly player ordering goes .331, .260, .193 as the
       * model takes none, half and all of the call. A call turns on
       * sharp steps in the distance, 72% run on third and one and 19%
       * on third and eight, and the cells have tens of thousands of
       * plays at each and reproduce the step, where a tree of this
       * depth smooths across it.
       */
      if (said !== undefined) {
        const onModel = Number(process.env["CALL_MODEL"] ?? 0);

        return Math.max(0.05, Math.min(0.95,
          onModel * said + (1 - onModel) * leagueRate));
      }

      if (!offence) {
        return leagueRate;
      }

      /**
       * How much a side's mix is its own depends on the quarter. In
       * neutral situations a team's run rate agrees with itself across
       * weeks at 0.54 in the first quarter, where the opening is
       * scripted, 0.40 in the third after halftime resets it, and
       * 0.29 and 0.26 in the second and fourth where the game decides.
       * The walk used to trust a side's own rate the same all game.
       */
      const q = state.secondsLeft > 2700 ? 0 : state.secondsLeft > 1800 ? 1
        : state.secondsLeft > 900 ? 2 : 3;
      const itsOwn = [0.54, 0.29, 0.40, 0.26][q]!;
      const own = forSide(byOffence, offence, state, settings.leastForSide);

      if (own.plays < settings.leastForSide || own.leaguePlays === 0) {
        return leagueRate;
      }

      /**
       * The side's mix as a leaning on the league's, both read over the
       * same cells, applied to the rate the situation calls for. Blending
       * the side's rate in directly let its any-score mix water down the
       * situation whenever its own pool had to widen.
       */
      const leaning = (own.runs / own.plays) /
        Math.max(0.05, own.leagueRuns / own.leaguePlays);

      return Math.max(0.05, Math.min(0.95,
        leagueRate * ((1 - itsOwn) + itsOwn * leaning)));
    },
    goesTo: (state, call, among, sides) => {
      const itsCells = atCells(
        state, settings.leastForMan * Math.max(1, among.length), call,
      );
      let here = 0;

      for (const cell of itsCells) {
        here += touchesOf(cell);
      }

      const shares = new Map<string, number>();
      let total = 0;

      for (const player of among) {
        let touches = 0;

        for (const cell of itsCells) {
          touches += cell.byPlayer.get(player)?.touches ?? 0;
        }

        if (!projected && !split) {
          shares.set(player, touches);
          total += touches;
          continue;
        }

        // How much more of the work he takes here than he takes in
        // general. A man used on third down leans that way whatever his
        // overall share turns out to be next season.
        const hisOverall = (overall.get(player) ?? 0) / Math.max(1, everyTouch);
        const hisHere = here > 0 ? touches / here : 0;
        const leaning = hisOverall > 0 && hisHere > 0
          ? hisHere / hisOverall
          : 1;
        const half = split?.get(player);
        const projectedShare = half
          ? (call === "run" ? half.carries : half.targets)
          : projected?.get(player) ?? 0;
        /**
         * What this defence is likely playing, and how much of his
         * usual share he takes against it. His slice moves .70 to
         * 1.59 across men and where he sits lasts to the next season
         * at .32, and nothing in the walk knew it.
         */
        const facing = call === "pass" && coverage && sides?.defence
          ? (() => {
              const man = coverage.manRate(sides.defence);

              return man * coverage.underMan(player) + (1 - man);
            })()
          : 1;
        /**
         * The projection says how big a share he wins and the counts
         * only lean it toward the downs he is used on. Last season's
         * counts on their own put the right man top of the list 34.6%
         * of the time where all of this together manages 29.1%, so
         * some of the level is theirs to say.
         */
        const said = projectedShare * leaning;
        const weight = (FROM_COUNTS <= 0 || touches <= 0 || said <= 0
          ? said
          : said ** (1 - FROM_COUNTS) * touches ** FROM_COUNTS) *
          facing *
          (settings.readsTheScript === false
            ? 1
            : scriptLeaning(player, call, state));
        shares.set(player, weight);
        total += weight;
      }

      if (total === 0) {
        for (const player of among) shares.set(player, 1 / among.length);
        return shares;
      }

      for (const [player, weight] of shares) shares.set(player, weight / total);

      return shares;
    },
    gains: (state, call, player, uniform, sides) => {
      const cell = at(state, settings.least, call);
      const own = cell.byPlayer.get(player);
      const pool = cell.yards;

      if (!pool.length) {
        return 4;
      }

      // the score and clock, put back when the pool had to let them go
      const tilt = settledAt.get(cell) === 2
        ? situationTilt(state, call)
        : { gain: 1, dry: 1 };

      /**
       * Whether this is one of his long ones is decided first, from how
       * often he breaks them, and the yards are then drawn from that
       * end of the pool.
       *
       * Scaling every draw by what he averages gives a possession
       * receiver and a deep threat the same shape when they average the
       * same. Breaking a twenty runs from 1.5% of touches to 14.7%
       * across men, lasts from season to season at .755, and is mostly
       * not what his average already says, .684 of it surviving once
       * the average is taken out.
       */
      /**
       * On a throw, the man's own depth picks which pool.
       *
       * How far downfield he is thrown carries to the next season at
       * .877, so it is the surest thing we know about him, and it
       * settles how often the throw gains nothing as well as how much
       * it makes when it does.
       */
      /**
       * Room is asked for only near enough to score. Out at a side's
       * own twenty five, keeping the throws that had seventy five
       * yards in front of them keeps only throws from a side's own
       * end, which are different plays, and receivers read .235
       * against .277 for it. In close it is the throws with no room
       * that were never going to be long.
       */
      const atDepth = depth && call === "pass" && player
        ? gainsAtDepth(
            cell, bandHere(cell, depth.leaningOf(player), uniform),
            state.yardline <= DEPTH_ROOM_UPTO ? state.yardline : 0,
          )
        : undefined;
      /**
       * Only the gains that had room to be this long.
       *
       * A play from the eleven cannot make more than eleven yards, so
       * drawing one for a play from the forty five caps what can come
       * out. The pool keeps where each gain came from for exactly this
       * and nothing has ever read it: 13.5% of the model's touchdowns
       * come from outside the twenty where 24% of real ones do, which
       * is the half the comment predicted.
       */
      /**
       * And only out in the field, where the cut matters.
       *
       * Inside the twenty the filter throws away the short stuffed
       * runs from the ten and the twelve, which are the plays that
       * should happen there, and the red zone starts converting 62%
       * where sides convert 57%.
       */
      const hadRoom = atDepth || state.yardline <= settings.roomBeyond ||
        state.yardline > settings.roomUpTo || process.env["NO_ROOM"]
        ? undefined
        : roomFor(cell, state.yardline);
      const drawFrom = atDepth && atDepth.length >= 20 ? atDepth
        : hadRoom && hadRoom.length >= settings.leastWithRoom ? hadRoom
        : pool;
      const longOnes: number[] = [];
      const shortOnes: number[] = [];
      const wentNowhere: number[] = [];

      for (const gained of drawFrom) {
        if (gained <= 0) {
          wentNowhere.push(gained);
          continue;
        }

        (gained >= 20 ? longOnes : shortOnes).push(gained);
      }

      /**
       * Whether it went anywhere at all, decided before how far.
       *
       * A third of throws gain nothing because nobody caught them, and
       * that is most of what a good defence does. Multiplying a drawn
       * gain can never produce one, since nothing times anything is
       * nothing, so which end of the pool to draw from is asked first.
       */
      const wentNowhereHere =
        (wentNowhere.length / Math.max(1, drawFrom.length)) * tilt.dry;
      const stuffed = playLevel && sides
        ? Math.max(0, Math.min(0.95,
            wentNowhereHere * playLevel.stuffedBy(state, call, player, sides)))
        : Math.min(0.95, wentNowhereHere);

      if (wentNowhere.length && uniform() < stuffed) {
        return wentNowhere[Math.floor(uniform() * wentNowhere.length)]!;
      }

      const gainful = longOnes.length + shortOnes.length;
      const leagueLong = longOnes.length / Math.max(1, gainful);
      /**
       * Him against the league, both measured over the same plays.
       *
       * At this state when he has been here enough, otherwise over
       * everything he did on this call. The two have to be compared at
       * the same scope: his season average against a goal line average
       * would make every man look twice as good near the line.
       */
      const wide = byMan.get(`${player}|${call}`);
      const atState = own && own.touches >= settings.leastForMan
        ? { his: own, league: cell.named }
        : undefined;
      const found = atState ?? (wide && wide.touches >= settings.leastForMan
        ? { his: wide, league: leagueOn.get(call) }
        : undefined);
      const hisLong = found?.league && found.league.touches > 0 && found.league.long > 0
        ? Math.max(0, Math.min(0.6,
            leagueLong * (found.his.long / found.his.touches) /
              (found.league.long / found.league.touches)))
        : leagueLong;
      const from = uniform() < hisLong && longOnes.length ? longOnes
        : shortOnes.length ? shortOnes : longOnes.length ? longOnes : pool;
      const drawn = from[Math.floor(uniform() * from.length)]!;

      if (!found?.league || drawn <= 0) {
        return drawn > 0 ? drawn * tilt.gain : drawn;
      }

      // and his level on top, against what everybody made over the
      // same plays, with the long ones taken out of it since the draw
      // above has already put them in
      const league = found.league.yards / Math.max(1, found.league.touches);
      const his = found.his.yards / Math.max(1, found.his.touches);
      const leagueLongRate = found.league.long / Math.max(1, found.league.touches);
      const hisLongRate = found.his.long / Math.max(1, found.his.touches);
      // and how far it went, now that whether it went anywhere has
      // already been settled above
      const level = playLevel && sides
        ? playLevel.levelFor(state, call, player, sides)
        : his / Math.max(0.1, league);
      const shape = leagueLongRate > 0 && hisLongRate > 0 &&
        !process.env["NO_LONG_SHAPE"]
        ? level * (leagueLongRate / hisLongRate) ** 0.5
        : level;

      const centre = process.env["NO_CENTRE"] ? 1 : centreOf.get(call) ?? 1;
      const bent = drawn * tilt.gain * afterCatchTilt(call, player) *
        (sides?.shotgun !== undefined
          ? drawnFormationTilt(state, call, sides.shotgun)
          : formationTilt(state, call, sides?.offence)) *
        lookTilt(state, call, sides?.shotgun ?? false, sides?.shell) *
        Math.max(0.5, Math.min(1.8, HOW_FAR === 1 ? shape : shape ** HOW_FAR)) /
          Math.max(0.5, centre);

      if (!sides || bent <= 0 || playLevel) {
        return bent;
      }

      let byPeople = 1;

      if (people?.defenceNow && sides.defence && sides.season && sides.week) {
        byPeople *= people.defenceNow(sides.defence, sides.season, sides.week, call);
      }

      if (people?.passing && call === "pass" && sides.passer) {
        byPeople *= people.passing(player, sides.passer);
      }

      if (byPeople !== 1) {
        return bent * byPeople;
      }

      if (pairing && sides.offence && sides.defence) {
        return bent * pairing(sides.offence, sides.defence, call);
      }

      // and what the two sides do to it, each against what everybody
      // does from here, held near one since a side is not that
      // different from the rest
      /**
       * A ratio needs far fewer plays than a distribution does, so the
       * sides are asked with a lower bar than the pool itself. Asking
       * for three hundred of one team's plays at one state meant the
       * answer was one every time and the teams never differed.
       */
      const leagueYards = cell.plays === 0
        ? 0
        : cell.yards.reduce((a, b) => a + b, 0) / cell.plays;
      const held = (found: { plays: number; yardsSum: number }) => {
        if (leagueYards <= 0 || found.plays < settings.leastForSide) {
          return 1;
        }

        return Math.max(0.8, Math.min(1.25, average(found) / leagueYards));
      };
      const theirs = sides.offence
        ? held(forSide(byOffence, sides.offence, state, settings.leastForSide, call))
        : 1;
      const against = sides.defence
        ? held(forSide(byDefence, sides.defence, state, settings.leastForSide, call))
        : 1;

      return bent * theirs * against;
    },
    scores: (state, call, gained) => {
      if (state.yardline - gained <= 0) {
        return 1;
      }

      const cell = atCounts(state, settings.least, call);
      return cell.plays === 0 ? 0 : cell.scores / cell.plays;
    },
    crossedStands: (state, call, uniform) => {
      makeRoom(crossRemembered);
      const key = `${call}|${stateKey(
        state.down, state.toGo, state.yardline, state.secondsLeft, state.margin,
      )}`;
      let keeps = crossRemembered.get(key);

      if (keeps === undefined) {
        const cell = at(state, settings.least, call);
        let crossed = 0;

        for (const gained of cell.yards) {
          if (gained >= state.yardline) {
            crossed++;
          }
        }

        const crossShare = crossed / Math.max(1, cell.yards.length);
        const counted = atCounts(state, settings.leastForSide, call);
        const scoreRate = counted.plays === 0
          ? crossShare
          : counted.scores / counted.plays;
        keeps = crossShare > 0 ? Math.min(1, scoreRate / crossShare) : 1;
        crossRemembered.set(key, keeps);
      }

      return uniform() < keeps;
    },
  };
}
