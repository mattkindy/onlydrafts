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
  emptyCell, marginBand, nearnessWeight, spotOrder, stateCode, stateKey,
  STATE_CODES, timeBand, wholeIn,
  type Call, type PlayFactors, type PlayState, type StateCell,
} from "../model/playFactors.js";
import type { RunParts } from "./runParts.js";
import type { PlayLevel } from "./playLevel.js";
import { bandOf, type TargetDepth } from "./targetDepth.js";
import type { Formation } from "./fitFormation.js";
import type { Coverage } from "./fitCoverage.js";
import type { Look } from "./fitLook.js";
import type { AfterCatch } from "./fitAfterCatch.js";
import type { Unaimed } from "./fitUnaimed.js";
import { seededRng, standardNormal } from "../sim/rng.js";

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

interface FactorSettings {
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
  /** touches needed before a player's own share at a state is believed */
  leastForPlayer: number;
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
  least: 300, leastForCall: 80, leastForPlayer: 40, leastForSide: 60,
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
interface Rate {
  touches: number;
  yards: number;
  /** and how many of them went for twenty or more */
  long: number;
  /**
   * and what those long ones made, so a player's level can be worked out
   * on his ordinary touches. Whether this is one of his long ones is
   * already decided before the level is applied, so a level with the
   * long ones still in it counts them twice.
   */
  longYards: number;
}

const emptyRate = (): Rate =>
  ({ touches: 0, yards: 0, long: 0, longYards: 0 });

const addTo = (into: Map<string, Rate>, key: string, yards: number): void => {
  const own = into.get(key) ?? emptyRate();
  own.touches++;
  own.yards += yards;

  if (yards >= 20) {
    own.long++;
    own.longYards += yards;
  }

  into.set(key, own);
};

/** everything counted at one state, plus who touched it there */
interface Counted extends StateCell {
  byPlayer: Map<string, {
    touches: number; yards: number; scores: number;
    /** and how often he breaks a long one, which is his own and lasts */
    long: number;
    /** with what those made, so his level can leave them out */
    longYards: number;
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
 * Gains to draw one from, each with the yardline it was made at, so
 * the draw can count the near ones more than the far ones.
 */
interface Drawable { yards: number[]; from: number[] }

/**
 * The same, split by what it was worth and carrying each play's
 * weight, worked out once while the pool is being split.
 */
interface Weighted { yards: number[]; weights: number[]; total: number }

const emptyWeighted = (): Weighted => ({ yards: [], weights: [], total: 0 });

/** one gain out of a split pool, the near ones coming up more often */
const drawWeighted = (pool: Weighted, uniform: () => number): number => {
  let left = uniform() * pool.total;

  for (let i = 0; i < pool.yards.length; i++) {
    left -= pool.weights[i]!;

    if (left <= 0) {
      return pool.yards[i]!;
    }
  }

  return pool.yards[pool.yards.length - 1]!;
};

/**
 * Which depth this throw goes to, from what happens here tilted by how
 * this player is used.
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
const gainsAtDepth = (cell: Counted, band: number, room = 0): Drawable => {
  const found: Drawable = { yards: [], from: [] };
  const take = (at: number) => {
    const gains = cell.byDepth.get(at) ?? [];
    const from = cell.byDepthFrom.get(at) ?? [];

    for (let i = 0; i < gains.length; i++) {
      if (room <= 0 || (from[i] ?? 0) >= room) {
        found.yards.push(gains[i]!);
        found.from.push(from[i] ?? 0);
      }
    }
  };

  take(band);

  for (let step = 1; step < 6 && found.yards.length < 40; step++) {
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
  return room > 0 && found.yards.length < 20 ? gainsAtDepth(cell, band) : found;
};

/**
 * The gains from spots with at least this much field in front of them.
 *
 * Kept in the order they were counted, so the yards and where they
 * came from line up.
 */
const drawableForYardline = (cell: Counted, yardline: number): Drawable => {
  const found: Drawable = { yards: [], from: [] };

  for (let i = 0; i < cell.yards.length; i++) {
    if ((cell.from[i] ?? 0) >= yardline) {
      found.yards.push(cell.yards[i]!);
      found.from.push(cell.from[i]!);
    }
  }

  return found;
};

const countIn = (rate: Rate, yards: number): void => {
  rate.touches++;
  rate.yards += yards;

  if (yards >= 20) {
    rate.long++;
    rate.longYards += yards;
  }
};

/**
 * What share of his offence's work each player is expected to take.
 *
 * Left out, the factors divide the work by what each player did before,
 * which is the weakest way we have of guessing a share: .596 against
 * .747 for working it out from who he is competing with. Passed in,
 * that model sets how much a player gets and the history only says where
 * he gets it.
 */
type ProjectedShares = Map<string, number>;

/**
 * The same, with the two halves of a player's work kept apart.
 *
 * One combined share lets a receiver's target volume leak onto run
 * plays. With the halves separate, a carry is divided by who competes
 * for carries and a throw by who competes for targets.
 */
type SplitProjected = Map<string, { carries: number; targets: number }>;

/**
 * What these two sides together do to a play, against what an average
 * pair does.
 *
 * The counts below ask each side on its own, so an offence that has
 * gained a lot and a defence that has given up little multiply
 * together as though neither had met the other. They also cannot see a
 * defence whose players have changed since those plays.
 */
type Pairing = (offence: string, defence: string, call: Call) => number;

export type { RunParts } from "./runParts.js";

export type { PlayLevel } from "./playLevel.js";

/** everything the counting pass produces, which is all the fit needs */
/**
 * The plays themselves, kept whole, so an outcome can be drawn as a
 * package instead of assembled from parts.
 *
 * A player's play carries its yards and its catch together, correlated
 * the way reality correlated them, and drawing his own play needs no
 * multiplier, no catch table and no centring, because nothing is a
 * ratio. The pooled path stays for the players too thin to sample.
 */
interface PlayStore {
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
  ofPlayer: Map<string, number[]>;
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
 * How much nearer the goal a borrowed play may have been made. A player
 * standing on the eighteen was drawing his own plunges from the two,
 * and they pulled the 11 to 30 bands 8 to 13% short of what plays
 * there gain, which is where drives stalled into field goals.
 */
const CLOSER = Number(process.env["CLOSER"] ?? 8);
/** the same guard past the thirty, where forty yards of slack let a
 * player at midfield draw plays whose gains the goal line had capped */
const FIELD_CLOSER = Number(process.env["FIELD_CLOSER"] ?? 40);
/**
 * How much a play a season old counts against one from the latest
 * season, in a player's own pool. Drawing all four seasons evenly gave a
 * player his old form: Taylor drew 5.0 a carry off seasons he has not
 * run since, while Bijan's climb to 5.4 was watered to 4.7.
 */
const RECENT_FADE = Number(process.env["RECENT_FADE"] ?? 0.7);
const FADES = [0, 1, 2, 3, 4, 5].map((back) => Math.pow(RECENT_FADE, back));
/** and how much harder the formation cells fade, since their rate climbs */
const FORM_FADE = Number(process.env["FORM_FADE"] ?? 0.7);
const FORM_FADES = [0, 1, 2, 3, 4, 5].map((b) => Math.pow(FORM_FADE, b));

/**
 * Three switches for asking how much of a player the walk is using, all
 * off where they sit, and none of them paying on the board yet.
 *
 * HOW_FAR raises his level to a power, 0 turning it off. NO_LONG_SHAPE
 * drops the long gain correction from that level. FROM_COUNTS moves
 * the level of who gets the ball off the projection and onto the
 * counts, 1 being all counts.
 */
const HOW_FAR = Number(process.env["HOW_FAR"] ?? 1);
const FROM_COUNTS = Number(process.env["FROM_COUNTS"] ?? 0);

/**
 * How much of that same level comes off how often he took the call at
 * all, ignoring the state, 1 being all of it and 0 turning it off.
 *
 * It buys the average share and sells the top of the list at every
 * strength, so it is off. The scoreboard has the trade.
 */
const FROM_CALLS = Number(process.env["FROM_CALLS"] ?? 0);

/**
 * How much of the level of who gets the ball comes off what a player has
 * been taking lately rather than off the August projection, 1 being
 * all of it.
 *
 * FROM_COUNTS reads the same level off the state-conditioned counts,
 * which pool every season at the same weight and so say what a player was
 * two seasons ago. This asks the plays season by season instead. It
 * puts the right player top of the list a point more often, 35.6% against
 * 34.8%, and gives a week back: .317 at a quarter and .311 at a half
 * against .345 for standing the leaning down on its own. Off.
 */
const RECENT_LEVEL = Number(process.env["RECENT_LEVEL"] ?? 0);
/**
 * How many of a player's own plays in a cell it takes before his leaning
 * is believed. 0 believes every leaning however thin, which is how it
 * shipped until September 2026.
 *
 * The leaning is the ratio of two thin shares, and off three or four
 * plays it can be ten to one either way. Shrinking it by his own count
 * in the cell, not the cell's total, because a cell of four hundred
 * plays says nothing about a player who took three of them, puts the
 * right player top of the list 35% of the time against 29.6% over 2023 to
 * 2025 and reads .344 a week against .319, tight ends included. On a
 * season the first sixty picks order at .545 against .503 for 2025 and
 * .437 against .336 for 2024, while the whole list gives back about
 * .008 because the leaning was ordering the deep, unpriced players. Five
 * and twenty were worse than sixty for quarterbacks, so the setting is
 * not smooth in the middle.
 */
const LEAN_K = Number(process.env["LEAN_K"] ?? 60);

/**
 * What a player's leaning is pulled toward while his own count is thin:
 * his position's leaning at the same spot, rather than no view at all.
 *
 * Where a tight end gets the ball is a fact about tight ends before it
 * is a fact about him. They took 27 to 31% of the throws inside the
 * five and 20 to 23% past the forty in each of 2021 to 2025, and backs
 * went the other way. Pulling toward one left every player on his
 * season-wide share exactly where the cells are thinnest.
 *
 * His own leaning still says something his position has not, so the
 * count still decides how much of his own is used. Only the resting
 * place changes. Set NO_POSITION_LEAN to pull toward one again.
 */
const POSITION_LEAN = !process.env["NO_POSITION_LEAN"];
/**
 * And how many plays of its own a position needs at a spot before that
 * leaning is believed, the same shrinking LEAN_K does to a player. Far
 * smaller, because a position has ten to thirty times the plays a player
 * has in the same cell: inside the ten a tight end's position has
 * about eleven of the forty five the cell asks for, and the sampling
 * error on that is about the size of the spread the yardline really
 * puts on it, which is what a shrink of a half means.
 *
 * Ten and twenty read the same at the play layer, both a step above
 * pulling toward one. Ten leaves the tight end's share inside the five
 * at 23.1% where twenty leaves it at 22.3% and the throws were 26.8%.
 * Nothing at all reads 25.0% there and gives back the goal line run.
 */
const POSITION_K = Number(process.env["POSITION_K"] ?? 10);

/**
 * How many plays a player is asked for in the pool he rests on, against
 * the forty he is asked for in the one he is scored on. 0 leaves him
 * resting straight on his position, which is how it ships.
 *
 * Cells are thin everywhere, not only near the goal: the middle player
 * has four of the plays inside the five. Splitting a season odd and
 * even, his own leaning inside the twenty predicts his leaning inside
 * the five at .27 where his position predicts it at .00, and it wins
 * again two scores down late and on third and short. His position
 * wins only on throws near the goal, so it stays underneath. At 400
 * the goal line puts the right player top 52.5% and 45.9% against 51.5%
 * and 44.0%, and the whole layer is level on 2024.
 */
const WIDE_LEAN = Number(process.env["WIDE_LEAN"] ?? 0);
/**
 * And how many of his own plays that wider pool needs before its
 * leaning is believed over his position's. Larger than POSITION_K
 * because it is one player's count again, not a whole position's.
 */
const WIDE_K = Number(process.env["WIDE_K"] ?? 60);

/**
 * How far a player's cut of the work moves from one game to the next,
 * beyond the coin flips inside a single game, as a fraction of his
 * own cut. A run and a throw move differently, so there are two.
 *
 * The walk handed a player the same cut on every snap of every game, so a
 * game plan, a hot hand or a blowout moved nothing. A back's cut of
 * the carries swings 0.34 of itself game to game once the flips are
 * taken out, where the walk managed 0.07; a receiver's swings 0.19.
 * Both settings are about twice that, because one player's draw is then
 * normalised over everyone on the field, which takes half back out.
 */
const GAME_SHARE_RUN = Number(process.env["GAME_SHARE_RUN"] ?? 0.65);
const GAME_SHARE_PASS = Number(process.env["GAME_SHARE_PASS"] ?? 0.3);

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

/**
 * Whether the pools kept by depth also keep the sacks and the balls
 * thrown away.
 *
 * Every pass is offered one of those before anybody is asked for a
 * play of his own, so a pool that also keeps them counts them twice,
 * and only a throw that falls back to the pool pays for it. On the
 * 2025 throws where the walk falls back, it said the throw went
 * nowhere 48.9% of the time where those same throws really went
 * nowhere 39.2%, and gained 4.47 yards against 6.50. Set it to put
 * them back in.
 */
export const POOL_WASTE = Boolean(process.env["POOL_WASTE"]);

/**
 * Where the goal line starts, and how many plays a player is asked for
 * there against the forty he is asked for anywhere else.
 *
 * Five reads .343 a week where forty reads .331, and puts the right
 * player top of the list inside the ten 45.1% of the time on a run where
 * forty manages 42.1%. Tighter still keeps helping the goal line and
 * starts costing receivers, .260 at two against .280 at five.
 */
const LINE_IS_NEAR = Number(process.env["LINE_IS_NEAR"] ?? 10);
const GOAL_LEAST = Number(process.env["GOAL_LEAST"] ?? 5);
/**
 * A run and a throw ask separately. There are two players who can run it
 * from the three and five who can catch it, so a tight cell says much
 * more about the run than about the throw, and one number for both was
 * either loose for the run or tight for the throw.
 */
const GOAL_LEAST_RUN = Number(process.env["GOAL_LEAST_RUN"] ?? GOAL_LEAST);
const GOAL_LEAST_PASS = Number(process.env["GOAL_LEAST_PASS"] ?? GOAL_LEAST);
/** and how many the pool a play draws from is asked for there */
const GOAL_GAIN_LEAST = Number(process.env["GOAL_GAIN_LEAST"] ?? 300);

/**
 * A short gain near the goal is carried up to the line often enough
 * that the spot scores as often as sides do; a crossing draw is cut
 * back either way.
 *
 * The settling can only cut, so every spot inside the twenty came out
 * short, and every position with it. Over 2025 throws from the 11 to
 * the 20, a tight end scored on 11.8% of the walk's draws where he
 * really scored 18.8% of the time, a receiver 12.2% against 15.4% and
 * a back 9.7% against 11.2%. Carrying the short gains up puts those at
 * 15.8%, 15.7% and 11.4%. What it does to a whole drive is what used
 * to keep this off, and no bench here measures that. Set NO_GOAL_LIFT
 * to leave a short gain where it lands.
 */
const GOAL_LIFT = !process.env["NO_GOAL_LIFT"];

/**
 * Which calls the carry applies to when it is on.
 *
 * Over 2025 snaps inside the ten, runs scored 28.9% and the walk drew
 * 27.9% of them with nothing carried up and 30.0% with runs carried,
 * so a run is already where runs end up and lifting it overshoots.
 * Throws scored 39.3% against 30.6% drawn, and the carry is the only
 * thing narrowing that.
 */
const GOAL_LIFT_CALLS: Record<Call, boolean> = { run: false, pass: true };

/**
 * Puts back the cut that held a player to his own crossing share.
 *
 * Cutting a player by his own share pins every one of them to the league
 * rate from above and leaves the ones below it where they are, so the
 * players come out flatter than they are and the whole thing lands under
 * the rate it settles to: inside the ten the sampled throws crossed
 * 30.7% where the spot's own rate on throws that reached a player is
 * 34.9%. Cutting everybody by the one factor the yardline needs puts
 * the sampled throws at 33.2% and keeps a goal line tight end above a
 * receiver. Set it to cut a player by his own share again, which takes
 * about a point and a half off drives that reach the ten.
 */
const GOAL_CUT_HIS_OWN = Boolean(process.env["GOAL_CUT_HIS_OWN"]);

/**
 * Puts back the tilts on a sampled play that already reached the goal
 * line, out beyond the twenty where the goal line settling does not
 * reach.
 *
 * A player's own play that the end zone cut off gained exactly the yards
 * to the line, and the tilts land either side of one, so about half
 * of those draws came back short of the goal. Between the 21 and the
 * 40, throws crossed on 2.8% of the walk's draws where those same
 * throws really scored 5.3% of the time, and 3.5% with the tilts kept
 * off a draw that crossed, which gives back 37 of the 217 touchdowns
 * the 2025 snaps were missing. Set it to shave them again.
 */
const TILTS_TAKE_SCORES = Boolean(process.env["TILTS_TAKE_SCORES"]);

/**
 * What a draw near the goal is settled against: how often the pool it
 * came from reaches this goal line, how often it gained anything, and
 * how often sides really score from this spot.
 *
 * The first two are readings of the pool a draw is made from. The
 * third has to be pinned to the yardline instead, because the pool's
 * own plays were made further out and scored less often for that
 * reason alone. Reading it off the pool as well drops the drawn
 * touchdown rate inside the ten to 18% on runs where sides score 29%.
 */
export interface GoalSample {
  crossShare: number;
  gainfulShare: number;
  scoreRate: number;
}

/**
 * Where a draw near the goal ends up, given how often the pool it came
 * from crosses and how often sides really score from here.
 *
 * Cutting alone, which is what this did, leaves a player whose pool
 * crosses more often than sides score here short of the line every
 * time, and throws inside the ten then scored 29% where sides score
 * 39%. So a draw that crossed is kept as often as sides score, and a
 * throw that gained something without crossing is carried over often
 * enough to make up the rest.
 */
export const settleAtGoal = (
  state: PlayState, call: Call, drawn: number, uniform: () => number,
  sample: GoalSample,
): number => {
  if (drawn >= state.yardline) {
    const keeps = sample.crossShare > 0
      ? Math.min(1, sample.scoreRate / sample.crossShare)
      : 1;

    return uniform() < keeps ? drawn : Math.max(0, state.yardline - 1);
  }

  if (!GOAL_LIFT || !GOAL_LIFT_CALLS[call] || drawn <= 0) {
    return drawn;
  }

  if (sample.scoreRate > sample.crossShare &&
      sample.gainfulShare > sample.crossShare) {
    const lifts = (sample.scoreRate - sample.crossShare) /
      (sample.gainfulShare - sample.crossShare);

    return uniform() < lifts ? state.yardline : drawn;
  }

  return drawn;
};

/**
 * Whether a player's level leaves his long gains out of both sides of it.
 *
 * It is the right shape, since whether this is one of his long ones is
 * already settled before the level is applied. It orders backs by what
 * they make of a touch at .281 where the level with the long ones in
 * it manages .207, and it wants 1.04 times what it says where the old
 * one wants 1.35, which is as near calibrated as anything here gets.
 * It reads .339 a week against .343, backs .382 against .375 and
 * receivers .272 against .280, so it is off until the receivers are
 * understood.
 */
const ORDINARY_LEVEL = Boolean(process.env["ORDINARY_LEVEL"]);

/**
 * How much of a player's level is said, a run and a throw apart.
 *
 * A throw is already drawn from the pool at his own depth and from the
 * long end at his own rate of breaking one, so his level is a third
 * helping of the same player: the walk spreads receivers by what would
 * have to be .29 times as far to be right. Halving it reads .344 a
 * week against .343, with passers, backs and receivers all up.
 */
const LEVEL_ON_RUN = Number(process.env["LEVEL_ON_RUN"] ?? 1);
const LEVEL_ON_PASS = Number(process.env["LEVEL_ON_PASS"] ?? 1);

/**
 * A gain is a whole number of yards.
 *
 * The drive engine has always rounded what comes back from here, so
 * this changes nothing about how a game plays out. It makes the answer
 * whole where it is worked out instead, because a bench that asks this
 * directly and checks whether the gain reached the line gets a
 * different simulation than the one that ships: a yard drawn from the
 * one and multiplied by a tilt of .8 comes to .8 and stops short, and
 * two benches here were reading exactly that.
 */
const whole = (yards: number) =>
  process.env["PART_YARDS"] ? yards : Math.round(yards);

export function storePlays(rows: PlayRow[]): PlayStore {
  const kept = rows.filter((r) => r.player);
  const down = new Int8Array(kept.length);
  const toGo = new Int16Array(kept.length);
  const yardline = new Int8Array(kept.length);
  const yards = new Int16Array(kept.length);
  const caught = new Uint8Array(kept.length);
  const ofPlayer = new Map<string, number[]>();
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
    ofPlayer.set(key, [...(ofPlayer.get(key) ?? []), i]);

    if (r.call === "pass" && r.passer) {
      const pair = `${r.player}|${r.passer}`;
      ofPair.set(pair, [...(ofPair.get(pair) ?? []), i]);
    }
  });

  return {
    down, toGo, yardline, yards, caught, age, ofPlayer, ofPair,
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
 * A team down two scores throws to different players than one protecting
 * a lead, and a third and long is a different play from a first down.
 * The full state cells know this but never have enough plays to say
 * so about one player, so the same question is asked again in six coarse
 * buckets where everybody has hundreds.
 */
const scriptOf = (margin: number, down: number, toGo: number) => {
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
const formationBandOf = (
  call: Call, shotgun: boolean, yardline: number,
) =>
  `${call}|${shotgun ? "gun" : "centre"}|` +
  `${yardline <= 20 ? "close" : yardline <= 60 ? "middle" : "back"}`;

const atFormation = (
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
  byPlayer: Map<string, Rate>;
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
interface FactorExtras {
  /** each player's expected share of the work, one number for all of it */
  projected?: ProjectedShares;
  /** the same with the two halves kept apart, which wins if both given */
  split?: SplitProjected;
  /** and the same again off the last seasons of play, latest first */
  lately?: Map<string, { carries: number; targets: number }>;
  /** what one side does to another, from the network */
  pairing?: Pairing;
  runParts?: RunParts;
  /**
   * One model for the level with everybody on the play at once. Given
   * it, the per-player and per-side multipliers stand down.
   */
  playLevel?: PlayLevel;
  /** how far downfield each player is thrown, which picks his pool */
  depth?: TargetDepth;
  /**
   * What each player plays, so a player too thin at a spot can lean the way
   * his position leans there instead of the way he leans everywhere.
   */
  positions?: Map<string, string>;
  /** the players on that defence this week, and the quarterback */
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
  /** what each player makes once the ball is his, near one */
  afterCatch?: AfterCatch;
  /** how often a throw reaches nobody, and what a sack costs */
  unaimed?: Unaimed;
  /**
   * Who resembles whom, nearest first, so a player too thin to sample
   * borrows plays from players like him before falling to the crowd. A
   * possession receiver widens to possession receivers.
   */
  alike?: Map<string, string[]>;
  /**
   * What each player's own per-touch history says, as a multiple of his
   * position's average. Given it, a drawn gain and a drawn score for
   * that player are pulled to the rate the component line reads instead of
   * to the rate his three seasons of plays read.
   */
  perPlayer?: Map<string, PerPlayerLevel>;
  /**
   * Who a player too thin to sample borrows plays from: the players on his own
   * side who have the trailing usage, busiest first. `alike` reaches
   * across the league for players who resemble him, which still leaves a
   * throw to a fourth receiver drawn from the crowd.
   */
  standIn?: Map<string, string[]>;
}

/**
 * A player's shrunk per-touch rates as a multiple of his position's, one
 * number per call for the yards and one for the scores.
 */
export interface PerPlayerLevel {
  runYards: number;
  runScore: number;
  passYards: number;
  passScore: number;
  /** and the same for a quarterback, per attempt he throws */
  throwYards: number;
  throwScore: number;
}

/** how far a reconciled rate may move a draw either way */
const RECONCILE_BAND = { low: 0.6, high: 1.6 };

const withinBand = (ratio: number): number =>
  Math.max(RECONCILE_BAND.low, Math.min(RECONCILE_BAND.high, ratio));

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
   * And each player over everything he did on a call, with the league
   * beside him for comparison.
   *
   * Asking for his forty touches inside one widened state never found
   * them. The widening stops when the state has three hundred plays,
   * and the busiest player in such a state has thirty. So every carry and
   * every catch came out at the league's yards and no player differed
   * from any other, which is most of why the model moved a team game
   * by one point where what happened moves by ten.
   */
  const byPlayer = new Map<string, Rate>();
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
  // how much of the ball each player took overall, so his usage at one
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
      addTo(byPlayer, `${row.player}|${row.call}`, row.yards);
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
    // Keyed by the call as well: a run and a pass from the same spot
    // gain 4.5 yards against 6.1 and go to different players, so
    // pooling them meant the call decided nothing at all.
    const at = `${row.call}|` + stateKey(
      row.down, row.toGo, row.yardline, row.secondsLeft, row.margin,
    );
    // and the same play again under any clock and any score, so a thin
    // state can fall back to the spot itself
    const loose = `${row.call}|${Math.min(4, row.down)}|${Math.min(40, row.toGo)}` +
      `|${Math.min(99, row.yardline)}|any`;
    // and once more without the call, because how often a side runs has
    // to come from one cell counting both. Widening the two pools apart
    // finds eighty of each wherever it must, and comes out at fifty.
    const eitherWay = stateKey(
      row.down, row.toGo, row.yardline, row.secondsLeft, row.margin,
    );
    const eitherLoose =
      `${Math.min(4, row.down)}|${Math.min(40, row.toGo)}` +
      `|${Math.min(99, row.yardline)}|any`;
    /**
     * A sack or a ball thrown away is a pass play nobody was on. A
     * failed throw is offered one of those separately, so a pool that
     * kept them would charge for them twice.
     */
    const wasted = row.call === "pass" && !row.player && !POOL_WASTE;
    const cell = cells.get(at) ?? emptyCounted();
    cell.plays++;
    if (row.call === "run") cell.runs++;

    if (!wasted) {
      cell.yards.push(row.yards);
      cell.from.push(row.yardline);
    }

    cell.scores += row.touchdown;

    if (row.call === "pass" && row.airYards !== undefined &&
        (POOL_WASTE || row.player)) {
      const band = bandOf(row.airYards);
      cell.byDepth.set(band, [...(cell.byDepth.get(band) ?? []), row.yards]);
      cell.byDepthFrom.set(
        band, [...(cell.byDepthFrom.get(band) ?? []), row.yardline],
      );
    }

    if (row.player) {
      countIn(cell.named, row.yards);
      const own = cell.byPlayer.get(row.player) ??
        { touches: 0, yards: 0, scores: 0, long: 0, longYards: 0 };
      own.touches++;
      own.yards += row.yards;
      own.scores += row.touchdown;

      if (row.yards >= 20) {
        own.long++;
        own.longYards += row.yards;
      }

      cell.byPlayer.set(row.player, own);
    }

    cells.set(at, cell);

    const anyTime = cells.get(loose) ?? emptyCounted();
    anyTime.plays++;
    if (row.call === "run") anyTime.runs++;

    if (!wasted) {
      anyTime.yards.push(row.yards);
      anyTime.from.push(row.yardline);
    }

    anyTime.scores += row.touchdown;

    if (row.call === "pass" && row.airYards !== undefined &&
        (POOL_WASTE || row.player)) {
      const band = bandOf(row.airYards);
      anyTime.byDepth.set(band, [...(anyTime.byDepth.get(band) ?? []), row.yards]);
      anyTime.byDepthFrom.set(
        band, [...(anyTime.byDepthFrom.get(band) ?? []), row.yardline],
      );
    }

    if (row.player) {
      countIn(anyTime.named, row.yards);
      const own = anyTime.byPlayer.get(row.player) ??
        { touches: 0, yards: 0, scores: 0, long: 0, longYards: 0 };
      own.touches++;
      own.yards += row.yards;
      own.scores += row.touchdown;

      if (row.yards >= 20) {
        own.long++;
        own.longYards += row.yards;
      }

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

        if (!wasted) {
          side.yards.push(row.yards);
        }

        side.scores += row.touchdown;
        into.set(key, side);
      }
    }
  }
  return {
    cells, byOffence, byDefence, byPlayer, leagueOn, caughtAt, overall,
    everyTouch, inScript, scriptPlays, onCall, callPlays, fromFormation,
    yardsFromFormation,
    againstLook,
  };
}

/** a counted cell, with the key it was counted under */
interface PlacedCell {
  cellKey: string;
  cell: Counted;
}

/**
 * One row's cells, with the spot each was counted at, as toGo times 100
 * plus the yardline, in an array of its own so a walk reads the spots
 * in one sweep without going to each cell.
 */
interface CellRow {
  at: Int32Array;
  cells: PlacedCell[];
}

/**
 * Cells grouped by the down, the clock and the score they were counted
 * at. A widening pass reads one of these rows, or three when the score
 * is let go by a band either way, so a walk goes through the cells a row
 * has instead of looking up each of the hundreds of spots it passes.
 */
export type CellRows = Map<number, CellRow>;

/** a row still being filled */
type DraftRows = Map<number, { at: number[]; cells: PlacedCell[] }>;

/** and every side's, by team and then by call */
export type SideCells = Map<string, Map<Call | "both", CellRows>>;

/** where a cell counted under any score goes in place of a score band */
const ANY_SCORE = 9;

const rowOf = (down: number, time: number, band: number) =>
  (down * 8 + time) * 10 + band;

const callOfSideKey = (rest: string): [Call | "both", string] => {
  if (rest.startsWith("run|")) {
    return ["run", rest.slice(4)];
  }

  if (rest.startsWith("pass|")) {
    return ["pass", rest.slice(5)];
  }

  return ["both", rest];
};

/**
 * The cells whose key starts with this prefix, keyed by the rest, so a
 * walk looks a spot up with the key the widening already has instead of
 * building the prefixed one.
 */
export const cellsUnder = (cells: Map<string, Counted>, prefix: string) => {
  const under = new Map<string, Counted>();
  const lead = `${prefix}|`;

  for (const [key, cell] of cells) {
    if (key.startsWith(lead)) {
      under.set(key.slice(lead.length), cell);
    }
  }

  return under;
};

const startsWithDigit = (key: string) => {
  const first = key.charCodeAt(0);

  return first >= 48 && first <= 57;
};

/**
 * The row a state key belongs to and the spot it was counted at, or
 * nothing for a key the widening never builds, which a walk over the
 * keys would never have found either.
 */
const rowAndSpotOf = (cellKey: string): [number, number] | undefined => {
  if (!startsWithDigit(cellKey)) {
    return undefined;
  }

  const parts = cellKey.split("|");
  const [down, toGo, yardline] = parts.slice(0, 3).map(Number);

  if (!wholeIn(down!, 4) || !wholeIn(toGo!, 40) || !wholeIn(yardline!, 99)) {
    return undefined;
  }

  const at = toGo! * 100 + yardline!;

  if (parts.length === 4 && parts[3] === "any") {
    return [rowOf(down!, 0, ANY_SCORE), at];
  }

  const [time, band] = parts.slice(3).map(Number);

  if (parts.length === 5 && wholeIn(time!, 4) && wholeIn(band!, 8)) {
    return [rowOf(down!, time!, band!), at];
  }

  return undefined;
};

const addToRows = (rows: DraftRows, cellKey: string, cell: Counted) => {
  const placed = rowAndSpotOf(cellKey);

  if (!placed) {
    return;
  }

  const [row, at] = placed;
  const inRow = rows.get(row) ?? { at: [], cells: [] };
  inRow.at.push(at);
  inRow.cells.push({ cellKey, cell });
  rows.set(row, inRow);
};

const sealed = (draft: DraftRows): CellRows =>
  new Map([...draft].map(([row, { at, cells }]) =>
    [row, { at: Int32Array.from(at), cells }]));

/** cells keyed by the state alone, grouped into rows */
export const rowsOf = (cells: Map<string, Counted>): CellRows => {
  const draft: DraftRows = new Map();

  for (const [cellKey, cell] of cells) {
    addToRows(draft, cellKey, cell);
  }

  return sealed(draft);
};

export const splitBySide = (from: Map<string, Counted>): SideCells => {
  const drafts = new Map<string, Map<Call | "both", DraftRows>>();

  for (const [key, cell] of from) {
    const bar = key.indexOf("|");
    const who = key.slice(0, bar);
    const [call, cellKey] = callOfSideKey(key.slice(bar + 1));
    const his = drafts.get(who) ?? new Map<Call | "both", DraftRows>();
    const onCall = his.get(call) ?? new Map();
    addToRows(onCall, cellKey, cell);
    his.set(call, onCall);
    drafts.set(who, his);
  }

  return new Map([...drafts].map(([who, his]) =>
    [who, new Map([...his].map(([call, draft]) => [call, sealed(draft)]))]));
};

export interface SidePool {
  plays: number; runs: number; yardsSum: number;
  leaguePlays: number; leagueRuns: number;
}

/**
 * The rows a pass at this looseness reads, each with its place among the
 * keys the widening builds for one spot, which is score band order.
 */
const rowsAtLooseness = (
  looseness: number, down: number, time: number, band: number,
): [number, number][] => {
  if (looseness >= 2) {
    return [[rowOf(down, 0, ANY_SCORE), 0]];
  }

  if (looseness === 0) {
    return [[rowOf(down, time, band), 0]];
  }

  return [band - 1, band, band + 1]
    .filter((b) => b >= 0 && b <= 8)
    .map((b) => [rowOf(down, time, b), b - band + 1]);
};

/**
 * Cells laid out by spot for a walk, kept between walks and emptied after
 * each one, with a fresh one for a walk started inside another.
 */
const layouts: (PlacedCell | undefined)[][] = [];
let layoutsInUse = 0;

/**
 * Goes through the cells one widening pass reaches from a state, in the
 * order the pass reaches them, and stops after the first spot where
 * `enough` says so. Returns whether it stopped.
 *
 * Within a spot the cells come in score band order, and for each band in
 * the order the row sets were given, which is the order a walk looking
 * up each spot's keys would have found them in.
 */
export const walkWidening = (
  rowSets: (CellRows | undefined)[], state: PlayState, looseness: number,
  take: (placed: PlacedCell, set: number) => void,
  enough: () => boolean,
): boolean => {
  const { ranks, spots } = spotOrder(state.toGo, state.yardline);
  const sets = rowSets.length;
  const perSpot = 3 * sets;
  const bySpot = layouts[layoutsInUse] ?? [];
  layouts[layoutsInUse++] = bySpot;
  const filled: number[] = [];
  let lastSpot = 0;

  for (const [row, within] of rowsAtLooseness(
    looseness, Math.min(4, state.down), timeBand(state.secondsLeft),
    marginBand(state.margin),
  )) {
    for (let set = 0; set < sets; set++) {
      const inRow = rowSets[set]?.get(row);

      if (!inRow) {
        continue;
      }

      const { at, cells } = inRow;

      for (let i = 0; i < at.length; i++) {
        const rank = ranks[at[i]!]!;

        if (rank < 0) {
          continue;
        }

        const slot = rank * perSpot + within * sets + set;
        bySpot[slot] = cells[i];
        filled.push(slot);
        lastSpot = Math.max(lastSpot, rank);
      }
    }
  }

  let stopped = false;

  try {
    // past the last spot with a cell nothing changes, so nothing can stop
    for (let spot = 0; spot <= lastSpot && spot < spots; spot++) {
      let took = spot === 0;

      for (let slot = spot * perSpot; slot < (spot + 1) * perSpot; slot++) {
        const placed = bySpot[slot];

        if (!placed) {
          continue;
        }

        take(placed, slot % sets);
        took = true;
      }

      if (took && enough()) {
        stopped = true;
        break;
      }
    }
  } finally {
    for (const slot of filled) {
      bySpot[slot] = undefined;
    }

    layoutsInUse--;
  }

  return stopped;
};

/**
 * One side's plays around a state, widened until there are enough, with
 * the league summed over the same cells the side's plays came from.
 *
 * A side rarely has sixty plays at one score and clock, so its pool
 * widens past them, and a rate read there can only be compared against
 * the league read there too. Comparing it against the league's tight
 * pool mixed the any-score team mix into the situation and pulled every
 * extreme spot toward the middle.
 */
export const poolForSide = (
  state: PlayState, least: number,
  own: CellRows | undefined,
  league: Map<string, Counted>,
  yardsOf: (cell: Counted) => number,
): SidePool => {
  let found = { plays: 0, runs: 0, yardsSum: 0, leaguePlays: 0, leagueRuns: 0 };

  if (!own) {
    return found;
  }

  for (const looseness of [0, 1, 2]) {
    const pooled = { plays: 0, runs: 0, yardsSum: 0, leaguePlays: 0, leagueRuns: 0 };

    walkWidening([own], state, looseness, ({ cell, cellKey }) => {
      pooled.plays += cell.plays;
      pooled.runs += cell.runs;
      pooled.yardsSum += yardsOf(cell);
      const everybody = league.get(cellKey);

      if (everybody) {
        pooled.leaguePlays += everybody.plays;
        pooled.leagueRuns += everybody.runs;
      }
    }, () => pooled.plays >= least);

    found = pooled;

    if (found.plays >= least) {
      break;
    }
  }

  return found;
};

/** how far one looseness of a widening has been walked */
interface WalkedSoFar {
  cells: Counted[];
  /** how many cells had been gathered after each spot that added one */
  ends: number[];
  /** and the plays in them, added up in the order they were gathered */
  plays: number[];
  /** whether the walk went past every spot without being stopped */
  whole: boolean;
}

/**
 * The cells around one state in widening order, walked only as far as
 * somebody has asked, so a pool asked for again with a different number
 * of plays is cut from the same walk rather than walked again.
 */
export interface WidenedCells {
  /** the cells a walk stopping at `least` plays would have gathered */
  upTo: (least: number) => Counted[];
}

/** the first spot whose running plays reach `least`, or -1 */
const firstReaching = (plays: number[], least: number) => {
  if (plays.length === 0 || plays[plays.length - 1]! < least) {
    return -1;
  }

  let low = 0;
  let high = plays.length - 1;

  while (low < high) {
    const middle = (low + high) >> 1;

    if (plays[middle]! >= least) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }

  return low;
};

export const widenedCells = (
  state: PlayState, rows: CellRows,
): WidenedCells => {
  // copied, since a longer walk may be asked for after the caller has
  // moved its state on
  const from = { ...state };
  const walks: (WalkedSoFar | undefined)[] = [];
  const cuts = [0, 1, 2].map(() => new Map<number, Counted[]>());

  /** a fresh walk of one looseness, stopping once it has `least` plays */
  const walkTo = (looseness: number, least: number): WalkedSoFar => {
    const walk: WalkedSoFar = { cells: [], ends: [], plays: [], whole: false };
    let running = 0;
    walk.whole = !walkWidening([rows], from, looseness, ({ cell }) => {
      walk.cells.push(cell);
      running += cell.plays;
    }, () => {
      walk.ends.push(walk.cells.length);
      walk.plays.push(running);

      return running >= least;
    });

    return walk;
  };

  /**
   * The same prefix of the same walk every time, so a cut is kept by its
   * length and handed back as the same array.
   */
  const cutAt = (looseness: number, cells: Counted[], end: number) => {
    const already = cuts[looseness]!.get(end);

    if (already) {
      return already;
    }

    const cut = cells.slice(0, end);
    cuts[looseness]!.set(end, cut);

    return cut;
  };

  /** the walk so far when it went far enough, or a longer one */
  const walkFor = (looseness: number, least: number) => {
    const walked = walks[looseness];

    if (walked && (walked.whole || firstReaching(walked.plays, least) !== -1)) {
      return walked;
    }

    const walk = walkTo(looseness, least);
    walks[looseness] = walk;

    return walk;
  };

  /** the cells and plays one looseness gathers before stopping at `least` */
  const gatheredAt = (looseness: number, least: number) => {
    const walk = walkFor(looseness, least);
    const reached = firstReaching(walk.plays, least);
    const spot = reached === -1 ? walk.plays.length - 1 : reached;

    if (spot === -1) {
      return { cells: cutAt(looseness, walk.cells, 0), plays: 0 };
    }

    return {
      cells: cutAt(looseness, walk.cells, walk.ends[spot]!),
      plays: walk.plays[spot]!,
    };
  };

  return {
    upTo: (least) => {
      let found = cutAt(0, [], 0);
      let plays = 0;

      for (const looseness of [0, 1, 2]) {
        if (plays >= least) {
          break;
        }

        const gathered = gatheredAt(looseness, least);
        found = gathered.cells;
        plays = gathered.plays;
      }

      return found;
    },
  };
};

/**
 * A sum over a pooled list of cells, added up once per list and key in
 * the list's own order. A state asked about again hands back the same
 * list, so a player is summed over it once rather than once a play.
 */
export const summedOverCells = (
  each: (cell: Counted, key: string) => number,
) => {
  const remembered = new WeakMap<Counted[], Map<string, number>>();
  const keptFor = (list: Counted[]) => {
    const already = remembered.get(list);

    if (already) {
      return already;
    }

    const made = new Map<string, number>();
    remembered.set(list, made);

    return made;
  };

  return (list: Counted[], key: string) => {
    const kept = keptFor(list);
    const already = kept.get(key);

    if (already !== undefined) {
      return already;
    }

    let sum = 0;

    for (const cell of list) {
      sum += each(cell, key);
    }

    kept.set(key, sum);

    return sum;
  };
};

/**
 * Each of these players' touches over a pooled list of cells, added up
 * cell by cell in the list's order. A cell with fewer players in it than
 * are being asked about is gone through instead of asked about each.
 */
export const touchesAmong = (
  list: Counted[], among: string[],
): Map<string, number> => {
  const totals = new Map(among.map((player) => [player, 0]));

  for (const cell of list) {
    if (cell.byPlayer.size < totals.size) {
      for (const [player, own] of cell.byPlayer) {
        const sum = totals.get(player);

        if (sum !== undefined) {
          totals.set(player, sum + own.touches);
        }
      }

      continue;
    }

    for (const [player, sum] of totals) {
      const own = cell.byPlayer.get(player);

      if (own) {
        totals.set(player, sum + own.touches);
      }
    }
  }

  return totals;
};

/** a call as a small number for a memo key, with no call at all as its own */
const CALL_CODES: Record<Call | "both", number> = { run: 0, pass: 1, both: 2 };

export const callCode = (call?: Call) => CALL_CODES[call ?? "both"];

/** where a side stood, when a count is asked of one formation */
type Form = "gun" | "centre";

const FORM_CODES: Record<Form | "", number> = { "": 0, gun: 1, centre: 2 };

/** how many numbers of plays a packed memo key has room for */
const LEAST_CODES = 1 << 16;

/**
 * What a memo is kept under: a small whole number for whatever else the
 * question turned on, the state, and how many plays were asked for. It is
 * a number when all three pack and a string otherwise, and a number never
 * equals a string, so two questions share a key exactly when the string
 * keys the memos used to build would have matched.
 */
export const memoKey = (
  asked: number, state: PlayState, least: number,
): number | string => {
  const code = stateCode(
    state.down, state.toGo, state.yardline, state.secondsLeft, state.margin,
  );
  const packed = typeof code === "number" && wholeIn(least, LEAST_CODES - 1)
    ? (asked * STATE_CODES + code) * LEAST_CODES + least
    : undefined;

  if (packed !== undefined && Number.isSafeInteger(packed)) {
    return packed;
  }

  return `${asked}|${code}|${least}`;
};

/**
 * The key a widening walk is kept under. It reads the distance and the
 * yardline as they are rather than capped, because the walk itself does.
 */
export const walkKey = (state: PlayState, call?: Call): number | string => {
  const down = Math.min(4, state.down);
  const time = timeBand(state.secondsLeft);
  const band = marginBand(state.margin);

  if (!wholeIn(down, 4) || !wholeIn(state.toGo, 40) ||
      !wholeIn(state.yardline, 99)) {
    return `${call ?? "both"}|${down}|${state.toGo}|${state.yardline}` +
      `|${time}|${band}`;
  }

  return ((((callCode(call) * 5 + down) * 41 + state.toGo) * 100 +
    state.yardline) * 5 + time) * 9 + band;
};

export function fitPlayFactors(
  rows: PlayRow[],
  settings: FactorSettings = FACTOR_DEFAULTS,
  extras: FactorExtras = {},
): PlayFactors {
  const {
    projected, split, lately, pairing, playLevel, depth, people, plays,
    alike, formation, coverage, look, afterCatch, positions, perPlayer, standIn,
    unaimed,
  } = extras;
  const {
    cells, byOffence, byDefence, byPlayer, leagueOn, caughtAt, overall,
    everyTouch, inScript, scriptPlays, onCall, callPlays,
    fromFormation = new Map<string, { plays: number; runs: number }>(),
    yardsFromFormation = new Map<
      string, { plays: number; yards: number; dry: number; long: number }
    >(),
    againstLook = new Map<
      string, { plays: number; yards: number; dry: number }
    >(),
  } = extras.counted ?? countPlays(rows, !pairing);

  const underRemembered = new Map<string, Map<string, Counted>>();
  /** the cells under a call or a formation, or all of them without one */
  const cellsAt = (prefix?: string) => {
    if (!prefix) {
      return cells;
    }

    const already = underRemembered.get(prefix);

    if (already) {
      return already;
    }

    const made = cellsUnder(cells, prefix);
    underRemembered.set(prefix, made);

    return made;
  };
  const rowsRemembered = new Map<string, CellRows>();
  /** and the same cells grouped into rows, for walking a widening */
  const rowsAt = (prefix?: string) => {
    const already = rowsRemembered.get(prefix ?? "");

    if (already) {
      return already;
    }

    const made = rowsOf(cellsAt(prefix));
    rowsRemembered.set(prefix ?? "", made);

    return made;
  };

  /**
   * What this game is doing to each player's cut, drawn the first time he
   * is asked for and held until the next game starts. Nothing is drawn
   * outside a game, so a caller asking about a single snap gets the
   * projected cut on its own.
   */
  const gameTilt = new Map<string, number>();
  let gameDraw: (() => number) | undefined;

  const tiltFor = (player: string, call: Call) => {
    if (!gameDraw) {
      return 1;
    }

    const key = `${player}|${call}`;
    const already = gameTilt.get(key);

    if (already !== undefined) {
      return already;
    }

    const width = call === "run" ? GAME_SHARE_RUN : GAME_SHARE_PASS;
    // centred so a player's cut over many games still averages what the
    // projection said, since the exponential would otherwise lift it
    const drawn = Math.exp(width * standardNormal(gameDraw) - (width * width) / 2);
    gameTilt.set(key, drawn);

    return drawn;
  };

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
   * only the second half moves with the player.
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
   * How much more of the work a player takes when the game is going this
   * way than he takes on that call in general.
   *
   * Trailing teams throw to their best receiver and stop handing off,
   * and a third and long belongs to whoever can win it. His own
   * numbers are pulled toward taking no view until he has been in the
   * situation enough, since a player with nine catches while behind
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

    walkWidening([rowsAt(call)], state, looseness, ({ cell }) => {
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
      pooled.named.longYards += cell.named.longYards;

      for (const [player, own] of cell.byPlayer) {
        const already = pooled.byPlayer.get(player) ??
          { touches: 0, yards: 0, scores: 0, long: 0, longYards: 0 };
        already.touches += own.touches;
        already.yards += own.yards;
        already.scores += own.scores;
        already.long += own.long;
        already.longYards += own.longYards;
        pooled.byPlayer.set(player, already);
      }
    }, () => pooled.plays >= least);

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
  const sideRemembered = new Map<number | string, SidePool>();
  const forgetsAt = () => makeRoom(sideRemembered);
  /** each side as a small number, in the order it was first asked about */
  const sideCodes = new Map<string, number>();
  const sideCode = (who: string) => {
    const known = sideCodes.get(who);

    if (known !== undefined) {
      return known;
    }

    sideCodes.set(who, sideCodes.size);

    return sideCodes.size - 1;
  };
  const sideTables = new WeakMap<Map<string, Counted>, SideCells>();
  const sideTableOf = (from: Map<string, Counted>) => {
    const already = sideTables.get(from);

    if (already) {
      return already;
    }

    const table = splitBySide(from);
    sideTables.set(from, table);

    return table;
  };
  const sideCellsOf = (
    from: Map<string, Counted>, who: string, call?: Call,
  ) => sideTableOf(from).get(who)?.get(call ?? "both");
  /**
   * Sums only. This used to copy every yard of a side's pooled cells
   * into a fresh array three times a play, and once the per side counts
   * were connected those cells held whole team seasons.
   */
  const forSide = (
    from: Map<string, Counted>, who: string, state: PlayState,
    least: number, call?: Call,
  ) => {
    forgetsAt();
    const key = memoKey(sideCode(who) * 3 + callCode(call), state, least);
    const already = sideRemembered.get(key);

    if (already) {
      return already;
    }

    const found = poolForSide(
      state, least, sideCellsOf(from, who, call),
      cellsAt(call), summedOnce,
    );
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
  const remembered = new Map<number | string, Counted>();
  /**
   * Half goes rather than all of it: clearing everything made every
   * following lookup a fresh gather, and a map iterates in insertion
   * order, so dropping the older half keeps what the walk is asking
   * about right now.
   */
  const makeRoom = <K, V>(cache: Map<K, V>) => {
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
    const key = memoKey(callCode(call), state, least);
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
   * Near the line the pool is asked for less, for the same reason the
   * shares are. Asking three hundred plays out of the one reaches back
   * up the field to fill itself, and what comes back scores 38% where
   * a play from the one really scores 55%, and 43% from the three
   * where one scores 33%. A side does not score more often from
   * further away. The settle at the goal asks for the same pool, so
   * that it reads the gains a draw actually came from.
   */
  const goalPoolLeast = (state: PlayState): number =>
    state.yardline <= LINE_IS_NEAR ? GOAL_GAIN_LEAST : settings.least;

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
  const situationRemembered =
    new Map<number | string, { gain: number; dry: number }>();
  const situationTilt = (state: PlayState, call: Call) => {
    makeRoom(situationRemembered);
    const key = memoKey(callCode(call), state, 0);
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

        walkWidening([rowsAt(call)], state, looseness, ({ cell }) => {
          pooled.plays += cell.plays;
          pooled.yardsSum += summedOnce(cell);
          pooled.dry += driedOnce(cell);
        }, () => pooled.plays >= settings.leastForSide);

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
    new Map<number | string, { plays: number; runs: number; scores: number }>();
  /**
   * The two formations counted over one widening pass, so they stand
   * on the same states. Widening them apart put the gun and the
   * centre on different supports, and a ratio between those is not a
   * leaning, it is two answers to different questions.
   */
  const bothFormsRemembered = new Map<number | string, {
    gun: { plays: number; runs: number };
    centre: { plays: number; runs: number };
  }>();
  const atBothForms = (state: PlayState, least: number) => {
    makeRoom(bothFormsRemembered);
    const key = memoKey(0, state, least);
    const already = bothFormsRemembered.get(key);

    if (already) {
      return already;
    }

    let found = {
      gun: { plays: 0, runs: 0 }, centre: { plays: 0, runs: 0 },
    };
    const forms = ["gun", "centre"] as const;
    const inForm = forms.map((form) => rowsAt(form));

    for (const looseness of [0, 1, 2]) {
      if (found.gun.plays + found.centre.plays >= least) {
        break;
      }

      const pooled = {
        gun: { plays: 0, runs: 0 }, centre: { plays: 0, runs: 0 },
      };

      walkWidening(inForm, state, looseness, ({ cell }, set) => {
        const form = forms[set]!;
        pooled[form].plays += cell.plays;
        pooled[form].runs += cell.runs;
      }, () => pooled.gun.plays + pooled.centre.plays >= least);

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
    form?: Form,
  ) => {
    makeRoom(countsRemembered);
    const key = memoKey(
      FORM_CODES[form ?? ""] * 3 + callCode(call), state, least,
    );
    const already = countsRemembered.get(key);

    if (already) {
      return already;
    }

    let found = { plays: 0, runs: 0, scores: 0 };
    const lookIn = rowsAt([form, call].filter(Boolean).join("|"));

    for (const looseness of [0, 1, 2]) {
      if (found.plays >= least) {
        break;
      }

      const pooled = { plays: 0, runs: 0, scores: 0 };

      walkWidening([lookIn], state, looseness, ({ cell }) => {
        pooled.plays += cell.plays;
        pooled.runs += cell.runs;
        pooled.scores += cell.scores;
      }, () => pooled.plays >= least);

      found = pooled;
    }

    countsRemembered.set(key, found);

    return found;
  };

  /**
   * How often a play from this yardline scores, for standing a draw
   * that crossed the goal against.
   *
   * The state cell widens along the field before it lets go of the
   * down or the distance, and near the goal that is the wrong way
   * round: a pass at the five was priced on passes from the fifteen,
   * and said 30% where passes inside the ten score 39%. The sampled
   * throws crossed 39% of the time and were cut down to the cell. So
   * this one keeps to the yardline and lets go of the distance, the
   * score, and then the down, and only then reaches along the field.
   */
  const scoreRemembered = new Map<string, number | undefined>();
  const scoreRateAt = (state: PlayState, call: Call): number | undefined => {
    const key = `${call}|${state.down}|${state.yardline}`;

    if (scoreRemembered.has(key)) {
      return scoreRemembered.get(key);
    }

    const downs = [[Math.min(4, state.down)], [1, 2, 3, 4]];
    let rate: number | undefined;

    outer: for (const reach of [0, 1, 2, 3, 5, 8]) {
      for (const some of downs) {
        let plays = 0;
        let scores = 0;

        for (let yard = state.yardline - reach; yard <= state.yardline + reach; yard++) {
          if (yard < 1 || yard > 99) {
            continue;
          }

          for (const down of some) {
            for (let toGo = 1; toGo <= Math.min(40, yard); toGo++) {
              const cell = cells.get(`${call}|${down}|${toGo}|${yard}|any`);

              if (cell) {
                plays += cell.plays;
                scores += cell.scores;
              }
            }
          }
        }

        if (plays >= settings.leastForSide) {
          rate = scores / plays;
          break outer;
        }
      }
    }

    scoreRemembered.set(key, rate);

    return rate;
  };

  /**
   * The yardline's score rate over the throws that reached a player.
   *
   * The cells count a sack as a throw that did not score, and neither
   * the pool nor a player's own record keeps the sacks, so a draw made
   * out of throws that reached somebody has to be settled against the
   * rate over those throws. Reading the rate over every throw cut a
   * pooled throw inside the ten to 34.8% where those plays scored
   * 39.3%.
   */
  const scoreRateToAPlayer = (
    state: PlayState, call: Call,
  ): number | undefined => {
    const found = scoreRateAt(state, call);

    if (found === undefined || call === "run" || !plays) {
      return found;
    }

    return found / Math.max(0.5, 1 - plays.wastedShareAt(state.yardline));
  };

  /**
   * What a pooled draw near the goal is settled against, read once per
   * state: how often the pool a draw here comes from reaches the goal
   * line, how often it gained anything, and how often sides score from
   * here. With the sacks back in the pool the whole rate is the one
   * that matches it.
   */
  const crossRemembered = new Map<number | string, GoalSample>();
  const goalSample = (state: PlayState, call: Call): GoalSample => {
    makeRoom(crossRemembered);
    const key = memoKey(callCode(call), state, 0);
    const already = crossRemembered.get(key);

    if (already) {
      return already;
    }

    // the pool a draw here actually comes from, so the crossing share
    // is measured over the gains being settled and not over a wider
    // pool the draw never sees
    const cell = at(state, goalPoolLeast(state), call);
    let crossed = 0;
    let gainful = 0;

    for (const yards of cell.yards) {
      if (yards >= state.yardline) {
        crossed++;
      }

      if (yards > 0) {
        gainful++;
      }
    }

    const drawn = Math.max(1, cell.yards.length);
    const crossShare = crossed / drawn;
    const found = POOL_WASTE
      ? scoreRateAt(state, call)
      : scoreRateToAPlayer(state, call);
    const sample: GoalSample = {
      crossShare,
      gainfulShare: gainful / drawn,
      scoreRate: found ?? crossShare,
    };
    crossRemembered.set(key, sample);

    return sample;
  };

  /**
   * The walk is kept per state and not per number of plays, since that
   * number grows with the cast and the same state was walked again for
   * every size of cast. Its key has everything the widening reads.
   */
  const walksRemembered = new Map<number | string, WidenedCells>();
  const widenedAt = (state: PlayState, call?: Call) => {
    makeRoom(walksRemembered);
    const key = walkKey(state, call);
    const already = walksRemembered.get(key);

    if (already) {
      return already;
    }

    const widened = widenedCells(state, rowsAt(call));
    walksRemembered.set(key, widened);

    return widened;
  };
  const cellsRemembered = new Map<number | string, Counted[]>();
  const atCells = (state: PlayState, least: number, call?: Call) => {
    makeRoom(cellsRemembered);
    const key = memoKey(callCode(call), state, least);
    const already = cellsRemembered.get(key);

    if (already) {
      return already;
    }

    const found = widenedAt(state, call).upTo(least);
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
  const allTouchesOver = summedOverCells((cell) => touchesOf(cell));

  /**
   * What each position took of a call anywhere on the field, once.
   *
   * The call and not everything, because a back takes 45% of the
   * touches and 20% of the throws, and reading his position's spot
   * against the first of those makes every pass cell look like a place
   * backs are kept out of. That is the run and the throw being told
   * apart, which the split projection already prices.
   */
  const positionOnCall = new Map<string, number>();

  if (POSITION_LEAN && positions) {
    for (const [key, took] of onCall) {
      const bar = key.lastIndexOf("|");
      const position = positions.get(key.slice(0, bar));

      if (position) {
        const at = `${position}|${key.slice(bar + 1)}`;
        positionOnCall.set(at, (positionOnCall.get(at) ?? 0) + took);
      }
    }
  }

  /** and the same at one cell, added up once per cell */
  const cellByPosition = new WeakMap<Counted, Map<string, number>>();
  const positionTouchesOf = (cell: Counted) => {
    const already = cellByPosition.get(cell);

    if (already) {
      return already;
    }

    const sums = new Map<string, number>();

    for (const [player, own] of cell.byPlayer) {
      const position = positions?.get(player);

      if (position) {
        sums.set(position, (sums.get(position) ?? 0) + own.touches);
      }
    }

    cellByPosition.set(cell, sums);

    return sums;
  };
  /** and over a pooled list, every position in one pass over its cells */
  const listByPosition = new WeakMap<Counted[], Map<string, number>>();
  const positionTouchesOver = (list: Counted[], position: string) => {
    const already = listByPosition.get(list);

    if (already) {
      return already.get(position) ?? 0;
    }

    const sums = new Map<string, number>();

    for (const cell of list) {
      for (const [at, took] of positionTouchesOf(cell)) {
        sums.set(at, (sums.get(at) ?? 0) + took);
      }
    }

    listByPosition.set(list, sums);

    return sums.get(position) ?? 0;
  };

  /**
   * How much more of the work this position takes here than it takes
   * anywhere, believed in proportion to how much of the spot is its
   * own. This is where a player with too few plays of his own is left.
   */
  const positionLeaning = (
    player: string, call: Call, itsCells: Counted[], here: number,
  ) => {
    const position = positions?.get(player);

    if (!POSITION_LEAN || !position || here <= 0) {
      return 1;
    }

    const overallShare = (positionOnCall.get(`${position}|${call}`) ?? 0) /
      Math.max(1, callPlays.get(call) ?? 0);
    const takenHere = positionTouchesOver(itsCells, position);

    if (overallShare <= 0 || takenHere <= 0) {
      return 1;
    }

    const believed = POSITION_K > 0
      ? takenHere / (takenHere + POSITION_K)
      : 1;

    return ((takenHere / here) / overallShare) ** believed;
  };

  /**
   * Where a player is left while his own count in this cell is too thin
   * to say, in two steps: his position's leaning here, and then his
   * own leaning over a pool several times the size.
   *
   * The wider pool is the same spot with the reach let out, so it is
   * still the goal line or the third down and not his season. A player's
   * own leaning inside the twenty says more about what he does inside
   * the five than his position does, so the position only catches him
   * when the wide pool has nothing of his either.
   */
  const restingPlace = (
    player: string, call: Call, itsCells: Counted[], here: number,
    wideTouches: number | undefined, wideHere: number,
  ) => {
    const position = positionLeaning(player, call, itsCells, here);

    if (wideTouches === undefined || wideHere <= 0) {
      return position;
    }

    const hisOverall = (onCall.get(`${player}|${call}`) ?? 0) /
      Math.max(1, callPlays.get(call) ?? 0);

    if (hisOverall <= 0 || wideTouches <= 0) {
      return position;
    }

    const believed = WIDE_K > 0 ? wideTouches / (wideTouches + WIDE_K) : 1;
    const leaning = (wideTouches / wideHere) / hisOverall;

    return position * (leaning / position) ** believed;
  };

  /**
   * What the level averages over the touches it is put on.
   *
   * A player's level is his yards against the league's, and the players who
   * get the ball are better than the average of everyone who ever
   * touched it, so the levels average above one and every play comes
   * out long. Asked about the plays a season really had, the walk
   * gained 4.66 on a carry against the 4.50 sides managed and 7.68 on
   * a throw against 7.32. Dividing by what it averages puts the level
   * back where it belongs and leaves what separates two players alone.
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

    for (const [key, his] of byPlayer) {
      if (!key.endsWith(`|${call}`) || his.touches < settings.leastForPlayer) {
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

  /**
   * How often anybody's play reaches the goal once it is moved here
   * the way a player's own plays are, counted over the same window his
   * draw uses.
   *
   * Moving a play in from further out is what makes a draw cross too
   * often: five yards gained at the nine is a touchdown at the four.
   * That happens to everybody's plays alike, so it is the number a
   * player's own crossing share has to be read against. His share on its
   * own says both what the move did and what kind of player he is,
   * and cutting him against it throws the second away.
   */
  const rowsOfCall = new Map<Call, number[]>();
  const crossedByAnyone = new Map<string, number>();
  const anyoneCrossesAt = (
    call: Call, yardline: number, room: number,
  ): number => {
    if (!plays) {
      return 0;
    }

    const key = `${call}|${yardline}|${room}`;
    const already = crossedByAnyone.get(key);

    if (already !== undefined) {
      return already;
    }

    let rows = rowsOfCall.get(call);

    if (!rows) {
      rows = [];

      for (const [who, his] of plays.ofPlayer) {
        if (who.endsWith(`|${call}`)) {
          rows.push(...his);
        }
      }

      rowsOfCall.set(call, rows);
    }

    let weight = 0;
    let crossed = 0;

    for (const i of rows) {
      const from = plays.yardline[i]!;

      if (from > yardline + room || from < yardline - CLOSER) {
        continue;
      }

      const fade = FADES[plays.age[i]!] ?? FADES[5]!;
      weight += fade;

      if (plays.yards[i]! >= yardline) {
        crossed += fade;
      }
    }

    const share = weight > 0 ? crossed / weight : 0;
    crossedByAnyone.set(key, share);

    return share;
  };

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
  /**
   * What a touch of this call comes to for a position, over every player
   * the pools have. This is the sim's own baseline for a player, and it is
   * what a reconciled rate has to be expressed against: `perPlayer` says
   * how a player compares with his position, so the sim's side of the
   * comparison has to be scoped the same way or every tight end moves.
   */
  const positionMeans = new Map<string, { yards: number; touches: number }>();

  if (perPlayer && positions) {
    for (const [key, rate] of byPlayer) {
      const at = key.lastIndexOf("|");
      const position = positions.get(key.slice(0, at));

      if (!position) {
        continue;
      }

      const into = positionMeans.get(`${position}|${key.slice(at + 1)}`) ??
        { yards: 0, touches: 0 };
      into.yards += rate.yards;
      into.touches += rate.touches;
      positionMeans.set(`${position}|${key.slice(at + 1)}`, into);
    }
  }

  const meanFor = (of: { yards: number; touches: number } | undefined) =>
    of && of.touches > 0 ? of.yards / of.touches : 0;

  const positionMean = (player: string, call: Call) =>
    meanFor(positionMeans.get(`${positions?.get(player) ?? ""}|${call}`));

  /** his own history against his position's, for the yards on this call */
  const wantedYards = (player: string, call: Call) => {
    const his = perPlayer?.get(player);

    if (!his) {
      return 1;
    }

    return call === "run" ? his.runYards : his.passYards;
  };

  /**
   * The reconciliation the pooled draw needs. Its level term is his own
   * plays over the league's on this call, so his history has to arrive
   * on that scale too: his multiple of his position, times what his
   * position comes to against the league.
   */
  const reconciledLevel = (player: string, call: Call, passer?: string) => {
    const mine = positionMean(player, call);
    const league = meanFor(leagueOn.get(call));

    if (mine <= 0 || league <= 0) {
      return undefined;
    }

    const throwing = call === "pass" && passer
      ? perPlayer?.get(passer)?.throwYards ?? 1
      : 1;

    return withinBand(wantedYards(player, call) * throwing) * (mine / league);
  };

  /**
   * And the reconciliation his own plays need, which is a smaller one:
   * those plays already are him, so what is left is his history against
   * what they say.
   */
  const reconciledSample = (player: string, call: Call, passer?: string) => {
    const his = byPlayer.get(`${player}|${call}`);
    const mine = positionMean(player, call);
    const throwing = call === "pass" && passer
      ? perPlayer?.get(passer)?.throwYards ?? 1
      : 1;
    const wanted = withinBand(wantedYards(player, call) * throwing);

    if (!his || his.touches < 25 || mine <= 0) {
      return wanted;
    }

    return withinBand(wanted / Math.max(0.4, meanFor(his) / mine));
  };

  /** how often a play from this spot on this call reaches the end zone */
  const crossesHere = (state: PlayState, call: Call) => {
    const cell = atCounts(state, settings.least, call);

    return cell.plays === 0 ? 0.2 : cell.scores / cell.plays;
  };

  /**
   * A drawn gain moved onto the goal line, or off it, so that the player
   * crosses as often as his own touchdown rate says. Only inside the
   * twenty: further out a score is a broken long gain, which the long
   * end of the pool already decides, and promoting draws out there
   * would hand the walk touchdowns from the forty.
   */
  const atHisScoreRate = (
    state: PlayState, call: Call, player: string, gained: number,
    uniform: () => number, passer?: string,
  ) => {
    const his = perPlayer?.get(player);

    if (!his || state.yardline > 20) {
      return gained;
    }

    const throwing = call === "pass" && passer
      ? perPlayer?.get(passer)?.throwScore ?? 1
      : 1;
    const wants = withinBand(
      (call === "run" ? his.runScore : his.passScore) * throwing,
    );
    const scored = gained >= state.yardline;

    if (wants > 1 && !scored && gained > 0) {
      const base = Math.min(0.8, crossesHere(state, call));
      const promote = base > 0 ? ((wants - 1) * base) / (1 - base) : 0;

      return uniform() < promote ? state.yardline : gained;
    }

    if (wants < 1 && scored && uniform() < 1 - wants) {
      return Math.max(0, Math.min(gained, state.yardline - 1));
    }

    return gained;
  };

  /** widened play lists, one per player and call, built once */
  const pooled = new Map<string, number[]>();

  const hisOwnDraw = plays
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
         * A throw between these exact two players first, when they have
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
            : plays.ofPlayer.get(`${player}|${call}`) ?? [];

          if (his.length < 25 && alike) {
            for (const twin of alike.get(player) ?? []) {
              his = his.concat(plays.ofPlayer.get(`${twin}|${call}`) ?? []);

              if (his.length >= 60) {
                break;
              }
            }
          }

          /**
           * And the players on his own side who have the trailing usage,
           * busiest first, for whoever `alike` could not fill either.
           * The alternative is the pooled draw, which gains 4.62 where
           * a targeted throw gains 7.33, so a fourth receiver is better
           * off borrowing from the players his side actually throws to.
           */
          if (his.length < 25 && standIn) {
            for (const busy of standIn.get(player) ?? []) {
              his = his.concat(plays.ofPlayer.get(`${busy}|${call}`) ?? []);

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

          // his sample crosses the goal more or less often than sides
          // score from this spot, and is settled to how often they do
          if (state.yardline <= 20) {
            const crossShare = GOAL_CUT_HIS_OWN
              ? crossedWeight / weight
              : anyoneCrossesAt(call, state.yardline, room);
            const found = scoreRateToAPlayer(state, call);
            const sample = {
              crossShare,
              gainfulShare: (weight - dryWeight) / weight,
              scoreRate: found ?? crossShare,
            };
            const settled = settleAtGoal(
              state, call, plays.yards[at]!, uniform, sample,
            );

            // a draw that scores is done with: the tilts below would
            // scale a five yard catch at the five to four and a half
            if (settled !== plays.yards[at]! || settled >= state.yardline) {
              return {
                yards: Math.min(state.yardline, settled),
                caught: settled > 0 || plays.caught[at] === 1,
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
           * A sampled play that already reached the goal line is a
           * touchdown, and the tilts below take back about half of
           * them. A play the end zone cut off gained exactly the
           * yards to the line, so any multiplier under one leaves it
           * short, and the multipliers land either side of one.
           */
          if (drawn >= state.yardline && !TILTS_TAKE_SCORES) {
            return {
              yards: state.yardline,
              caught: plays.caught[at] === 1,
            };
          }

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

  /**
   * The same draw with his own rates put back on it. His plays are three
   * seasons deep and unshrunk, so a player who broke two long ones in a
   * thin sample keeps making them; the component line reads four games
   * and last season and pulls a thin player toward his position.
   */
  const hisOwnPlay = hisOwnDraw && perPlayer
    ? (
        state: PlayState, call: Call, player: string, uniform: () => number,
        passer?: string,
        sides?: {
          offence?: string; defence?: string;
          passer?: string; season?: number; week?: number;
          shotgun?: boolean; shell?: string;
        },
      ) => {
        const drawn = hisOwnDraw(state, call, player, uniform, passer, sides);

        if (!drawn) {
          return undefined;
        }

        const yards = drawn.yards > 0
          ? Math.min(
              state.yardline,
              Math.round(drawn.yards * reconciledSample(player, call, passer)),
            )
          : drawn.yards;

        return {
          yards: atHisScoreRate(state, call, player, yards, uniform, passer),
          caught: drawn.caught,
        };
      }
    : hisOwnDraw;

  const built: PlayFactors = {
    /**
     * The snap settled before the call, which is how football works
     * and measures worse: every drawn layer adds variance, and a
     * week of a player's scoring orders at .314 this way against .343
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
    reachesNobody: unaimed
      ? (state, uniform) => unaimed.reaches(state.down, uniform)
      : undefined,
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
             * for the rate, and a week of a player reads .327 against
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
       * see the staff calling it and the players the defence has on the
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
    startsGame: (uniform) => {
      gameTilt.clear();

      if (GAME_SHARE_RUN <= 0 && GAME_SHARE_PASS <= 0) {
        gameDraw = undefined;
        return;
      }

      // seeded off the game's own stream, so the same fixture played
      // twice moves the same players, and drawn only when a width is set
      // so that turning both off leaves every other draw where it was
      gameDraw = seededRng(Math.floor(uniform() * 2 ** 31));
    },
    goesTo: (state, call, among, sides) => {
      /**
       * Near the line a cell is asked for less, because asking for
       * forty plays a player out of a spot that thin reaches the twenty
       * three and the thirty eight to fill itself, and the player who
       * gets it from the three is not the player who gets it from the
       * thirty eight. Everywhere else the reach costs nothing.
       */
      const wants = (state.yardline <= LINE_IS_NEAR
        ? (call === "run" ? GOAL_LEAST_RUN : GOAL_LEAST_PASS)
        : settings.leastForPlayer) * Math.max(1, among.length);
      const itsCells = atCells(state, wants, call);
      const here = allTouchesOver(itsCells, "");

      /**
       * The same spot asked of a pool several times the size, which is
       * where a player is left while his count in the tight one is thin.
       */
      const wideCells = WIDE_LEAN > 0
        ? atCells(state, WIDE_LEAN * Math.max(1, among.length), call)
        : undefined;
      const wideHere = wideCells ? allTouchesOver(wideCells, "") : 0;
      const tookHere = touchesAmong(itsCells, among);
      const tookWide = wideCells ? touchesAmong(wideCells, among) : undefined;
      const shares = new Map<string, number>();
      let total = 0;

      for (const player of among) {
        const touches = tookHere.get(player)!;

        if (!projected && !split) {
          shares.set(player, touches);
          total += touches;
          continue;
        }

        // How much more of this call he takes here than he takes of it
        // anywhere. A player used on third down leans that way whatever his
        // overall share turns out to be next season.
        const hisOverall = POSITION_LEAN
          ? (onCall.get(`${player}|${call}`) ?? 0) /
            Math.max(1, callPlays.get(call) ?? 0)
          : (overall.get(player) ?? 0) / Math.max(1, everyTouch);
        const hisHere = here > 0 ? touches / here : 0;
        const believed = LEAN_K > 0 ? touches / (touches + LEAN_K) : 1;
        // and where he is left while his own count is too thin to say
        const towards = restingPlace(
          player, call, itsCells, here, tookWide?.get(player), wideHere,
        );
        const leaning = hisOverall > 0 && hisHere > 0
          ? towards * ((hisHere / hisOverall) / towards) ** believed
          : towards;
        const half = split?.get(player);
        const projectedShare = half
          ? (call === "run" ? half.carries : half.targets)
          : projected?.get(player) ?? 0;
        /**
         * What this defence is likely playing, and how much of his
         * usual share he takes against it. His slice moves .70 to
         * 1.59 across players and where he sits lasts to the next season
         * at .32, and nothing in the walk knew it.
         */
        const facing = call === "pass" && coverage && sides?.defence
          ? (() => {
              const chanceOfMan = coverage.manRate(sides.defence);

              return chanceOfMan * coverage.underMan(player) +
                (1 - chanceOfMan);
            })()
          : 1;
        /**
         * The projection says how big a share he wins, and RECENT_LEVEL
         * moves that toward what he has been taking lately. A player the
         * projection does not price at all is left alone, so this only
         * changes how big a share the players on the field win and never
         * which of them are eligible for one.
         */
        const shownLately = lately?.get(player);
        const hisLately = shownLately
          ? (call === "run" ? shownLately.carries : shownLately.targets)
          : 0;
        const level = RECENT_LEVEL <= 0 || hisLately <= 0 || projectedShare <= 0
          ? projectedShare
          : projectedShare ** (1 - RECENT_LEVEL) * hisLately ** RECENT_LEVEL;
        // his share of the call over every side, so the denominator is
        // the same for everyone and normalising takes it back out
        const tookTheCall = onCall.get(`${player}|${call}`) ?? 0;
        const blended = FROM_CALLS <= 0 || tookTheCall <= 0 || level <= 0
          ? level
          : level ** (1 - FROM_CALLS) * tookTheCall ** FROM_CALLS;
        const said = blended * leaning;
        const weight = (FROM_COUNTS <= 0 || touches <= 0 || said <= 0
          ? said
          : said ** (1 - FROM_COUNTS) * touches ** FROM_COUNTS) *
          facing *
          tiltFor(player, call) *
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
      const cell = at(state, goalPoolLeast(state), call);
      const own = cell.byPlayer.get(player);
      const pool: Drawable = { yards: cell.yards, from: cell.from };

      if (!pool.yards.length) {
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
       * across players, lasts from season to season at .755, and is mostly
       * not what his average already says, .684 of it surviving once
       * the average is taken out.
       */
      /**
       * On a throw, the player's own depth picks which pool.
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
        : drawableForYardline(cell, state.yardline);
      const drawFrom = atDepth && atDepth.yards.length >= 20 ? atDepth
        : hadRoom && hadRoom.yards.length >= settings.leastWithRoom ? hadRoom
        : pool;
      const longOnes = emptyWeighted();
      const shortOnes = emptyWeighted();
      const wentNowhere = emptyWeighted();
      /**
       * What this pool makes on an ordinary touch, counted while it is
       * being split so it costs nothing. On a throw the pool is the one
       * at this player's own depth, and that is what his level has to be
       * measured against: a deep threat is already being dealt deep
       * throws, so measuring him against every throw in the league
       * credits him for the depth a second time.
       */
      let poolPlain = 0;
      let poolPlainOf = 0;
      let poolPlainWeight = 0;
      /**
       * Every share below is taken over the same weights the draw
       * uses. Reading how often the pool gained nothing off the raw
       * counts while drawing off the weighted ones would answer two
       * different questions about one pool.
       */
      let poolWeight = 0;

      for (let i = 0; i < drawFrom.yards.length; i++) {
        const gained = drawFrom.yards[i]!;
        const near = nearnessWeight(
          Math.abs((drawFrom.from[i] ?? state.yardline) - state.yardline));
        poolWeight += near;

        if (gained < 20) {
          poolPlain += gained * near;
          poolPlainWeight += near;
          poolPlainOf++;
        }

        const into = gained <= 0 ? wentNowhere
          : gained >= 20 ? longOnes
          : shortOnes;
        into.yards.push(gained);
        into.weights.push(near);
        into.total += near;
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
        (wentNowhere.total / Math.max(1e-9, poolWeight)) * tilt.dry;
      const stuffed = playLevel && sides
        ? Math.max(0, Math.min(0.95,
            wentNowhereHere * playLevel.stuffedBy(state, call, player, sides)))
        : Math.min(0.95, wentNowhereHere);

      if (wentNowhere.yards.length && uniform() < stuffed) {
        return drawWeighted(wentNowhere, uniform);
      }

      const gainful = longOnes.total + shortOnes.total;
      const leagueLong = longOnes.total / Math.max(1e-9, gainful);
      /**
       * Him against the league, both measured over the same plays.
       *
       * At this state when he has been here enough, otherwise over
       * everything he did on this call. The two have to be compared at
       * the same scope: his season average against a goal line average
       * would make every player look twice as good near the line.
       */
      const wide = byPlayer.get(`${player}|${call}`);
      const atState = own && own.touches >= settings.leastForPlayer
        ? { his: own, league: cell.named }
        : undefined;
      const found = atState ?? (wide && wide.touches >= settings.leastForPlayer
        ? { his: wide, league: leagueOn.get(call) }
        : undefined);
      const hisLong = found?.league && found.league.touches > 0 && found.league.long > 0
        ? Math.max(0, Math.min(0.6,
            leagueLong * (found.his.long / found.his.touches) /
              (found.league.long / found.league.touches)))
        : leagueLong;
      const end = uniform() < hisLong && longOnes.yards.length ? longOnes
        : shortOnes.yards.length ? shortOnes
        : longOnes.yards.length ? longOnes
        : wentNowhere;
      const drawn = drawWeighted(end, uniform);
      /**
       * What his own per-touch history says, when a caller has handed
       * the rates in. It replaces the level below rather than stacking
       * on it: both say how good a player is at this, the level off three
       * unshrunk seasons and the history off four games and last season
       * pulled toward his position.
       */
      const reconciled = perPlayer
        ? reconciledLevel(player, call, sides?.passer)
        : undefined;

      if (!found?.league || drawn <= 0) {
        if (drawn <= 0) {
          return drawn;
        }

        return whole(drawn * tilt.gain * (reconciled ?? 1));
      }

      // and his level on top, against what everybody made over the
      // same plays, with the long ones taken out of it since the draw
      // above has already put them in
      /**
       * His level on the ordinary touches, with the long ones taken
       * out of both sides of it.
       *
       * Whether this is one of his long ones was settled above, from
       * how often he breaks them, so a level worked out over all his
       * touches counts a big play player's long ones a second time. That
       * used to be undone by dividing by the square root of his rate
       * of breaking them, which blows up on a player with one long gain
       * in sixty touches and cost more than the level was worth: it
       * ordered backs by what they make of a touch at .14, where
       * having no level at all manages .22.
       */
      const plain = (of: { yards: number; touches: number; long: number;
        longYards: number }) =>
        (of.yards - of.longYards) / Math.max(1, of.touches - of.long);
      /**
       * Measured against the pool the draw came from when that pool is
       * his own depth, and against the league on this call otherwise.
       */
      const atHisDepth = ORDINARY_LEVEL && atDepth && poolPlainOf >= 20
        ? poolPlain / poolPlainWeight
        : 0;
      const league = !ORDINARY_LEVEL
        ? found.league.yards / Math.max(1, found.league.touches)
        : atHisDepth > 0 ? atHisDepth : plain(found.league);
      const his = ORDINARY_LEVEL
        ? plain(found.his)
        : found.his.yards / Math.max(1, found.his.touches);
      const leagueLongRate = found.league.long / Math.max(1, found.league.touches);
      const hisLongRate = found.his.long / Math.max(1, found.his.touches);
      // and how far it went, now that whether it went anywhere has
      // already been settled above
      const level = playLevel && sides
        ? playLevel.levelFor(state, call, player, sides)
        : his / Math.max(0.1, league);
      const asDrawn = ORDINARY_LEVEL || process.env["NO_LONG_SHAPE"]
        ? level
        : leagueLongRate > 0 && hisLongRate > 0
        ? level * (leagueLongRate / hisLongRate) ** 0.5
        : level;
      const said = reconciled ?? asDrawn;
      /**
       * How much of his level to say, which is not the same on a run
       * as on a throw. A throw is already drawn from the pool at his
       * own depth and from the long end at his own rate of breaking
       * one, so his level is a third helping of the same player and the
       * walk spreads receivers three times as far as it should. A run
       * is drawn from a pool that knows nothing about him, so his
       * level is all he has.
       */
      const saying = call === "pass" ? LEVEL_ON_PASS : LEVEL_ON_RUN;
      const shape = saying === 1 ? said : 1 + (said - 1) * saying;

      const centre = process.env["NO_CENTRE"] ? 1 : centreOf.get(call) ?? 1;
      const bent = drawn * tilt.gain * afterCatchTilt(call, player) *
        (sides?.shotgun !== undefined
          ? drawnFormationTilt(state, call, sides.shotgun)
          : formationTilt(state, call, sides?.offence)) *
        lookTilt(state, call, sides?.shotgun ?? false, sides?.shell) *
        Math.max(0.5, Math.min(1.8, HOW_FAR === 1 ? shape : shape ** HOW_FAR)) /
          Math.max(0.5, centre);

      if (!sides || bent <= 0 || playLevel) {
        return whole(bent);
      }

      let byPeople = 1;

      if (people?.defenceNow && sides.defence && sides.season && sides.week) {
        byPeople *= people.defenceNow(sides.defence, sides.season, sides.week, call);
      }

      if (people?.passing && call === "pass" && sides.passer) {
        byPeople *= people.passing(player, sides.passer);
      }

      if (byPeople !== 1) {
        return whole(bent * byPeople);
      }

      if (pairing && sides.offence && sides.defence) {
        return whole(bent * pairing(sides.offence, sides.defence, call));
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

      return whole(bent * theirs * against);
    },
    scores: (state, call, gained) => {
      if (state.yardline - gained <= 0) {
        return 1;
      }

      const cell = atCounts(state, settings.least, call);
      return cell.plays === 0 ? 0 : cell.scores / cell.plays;
    },
    atTheGoal: (state, call, gained, uniform) =>
      settleAtGoal(state, call, gained, uniform, goalSample(state, call)),
  };

  if (perPlayer) {
    const drawnFromThePool = built.gains;
    built.gains = (state, call, player, uniform, sides) =>
      atHisScoreRate(
        state, call, player,
        drawnFromThePool(state, call, player, uniform, sides),
        uniform, sides?.passer,
      );
  }

  return built;
}
