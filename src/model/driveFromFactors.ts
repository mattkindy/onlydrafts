/**
 * A drive as the play factors applied in sequence.
 *
 * Nothing about a drive is fitted here. How long they run, how often
 * they score, how often they stall: all of it comes out of the factors
 * and the chains, so a drive that comes out wrong points at a factor
 * rather than at a rule about drives.
 *
 * The fourth down choice, the kick and the punt are not play factors.
 * They decide whether a play happens at all, so they come in from
 * outside.
 */

import type { Call, PlayFactors, PlayState } from "./playFactors.js";
import type { DriveEnd } from "./drive.js";
import type { PlayClock } from "../features/fitPlayClock.js";
import type { FourthDown } from "../features/fitFourthDown.js";

export interface EndingRules {
  kickSucceeds: (yardline: number) => number;
  /**
   * What this ground does to a kick, near one. A roof helps a long
   * one and a cold afternoon costs one, and neither touches a chip
   * shot, so it comes in per kick rather than per season.
   */
  kickHere?: (yardline: number) => number;
  /**
   * And how willing the staff is to send him out here at all, which
   * moves more than the kick does: in the cold they go for it instead
   * about a fifth of the time they would otherwise have kicked.
   */
  kickAppetite?: number;
  puntLands: (yardline: number, uniform: () => number) => number;
  turnoverRate: (call: Call) => number;
  /** and the same off the state, where it is known */
  turnoverAt?: (state: PlayState, call: Call) => number;
  /**
   * A defensive penalty that hands over a first down. It happens on 16%
   * of drives and is the one way a drive carries on without the offence
   * doing anything. The older walks have it and this one was written
   * without it, which is most of why it does not finish.
   */
  penaltyFirstDown: number;
  penaltyYards: (uniform: () => number) => number;
  /**
   * A flag on the offence that replays the down from further back: a
   * false start or a hold, on 4.5% of snaps, five yards two times in
   * three and ten the rest. Without it every first down is first and
   * ten, and the walk ends on downs on 8.5% of drives where sides end
   * on 6.4%.
   */
  offenceFlag?: number;
  offenceFlagYards?: (uniform: () => number) => number;
  /** and a defensive offside that moves the ball five yards short of the chains */
  defenceFlag?: number;
  maxPlays: number;
}

export type PreSnapFlag = "offence" | "defence";

/**
 * Whether a flag wipes out this snap before it happens, and where the
 * ball goes if one does. The offence is set back by the flag or half
 * the distance to its own goal, whichever is less, and the down stays
 * as it was. A defensive one moves the ball up five, and reaches the
 * chains only when they were closer than that.
 */
export const preSnapFlag = (
  state: PlayState, rules: EndingRules, uniform: () => number,
): PreSnapFlag | undefined => {
  if (rules.offenceFlag && uniform() < rules.offenceFlag) {
    const drawn = rules.offenceFlagYards ? rules.offenceFlagYards(uniform) : 5;
    const back = Math.min(drawn, Math.floor((100 - state.yardline) / 2));
    state.yardline += back;
    state.toGo = Math.min(state.toGo + back, state.yardline);

    return "offence";
  }

  if (rules.defenceFlag && uniform() < rules.defenceFlag) {
    const up = Math.min(5, Math.floor(state.yardline / 2));
    state.yardline -= up;

    if (up >= state.toGo) {
      state.down = 1;
      state.toGo = Math.min(10, state.yardline);
    } else {
      state.toGo -= up;
    }

    return "defence";
  }

  return undefined;
};

/**
 * Which drive the half runs out on.
 *
 * Nearly seven percent of drives end that way. Taking a slice off every
 * drive instead cuts short the ones that were about to score, which
 * cost two points of touchdown rate. A half ends on one drive, so one
 * drive in fourteen gets a short budget of plays and the rest get none
 * of this at all.
 */
export interface ClockRules {
  /** how often a drive is the last of a half */
  isLast: number;
  /** how many snaps one of those gets, drawn */
  lastLength: (uniform: () => number) => number;
}

export const CLOCK_DEFAULTS: ClockRules = {
  isLast: 0.071,
  lastLength: (uniform) => 1 + Math.floor(uniform() * 12),
};

export interface FactorPlay {
  state: PlayState;
  call: Call;
  player: string;
  yards: number;
  scored: boolean;
  /** whether the throw was caught; a run always was */
  caught: boolean;
}

export interface FactorDrive {
  plays: FactorPlay[];
  ending: DriveEnd;
  /** where the other side takes over, counted from their own goal */
  handsOverAt: number;
  /** and how much of the clock went by, when one is being kept */
  took: number;
  /**
   * Where it stood at every fourth down it faced, since a drive can
   * go for one, convert, and face another. A punt or a kick returns
   * before any play is pushed, so this is the only way to see where
   * the choices were made.
   */
  facedAt: number[];
  /**
   * Where a kick was taken from, when the drive ended in one. The
   * distance decides whether it is a chip shot or a fifty yarder, and
   * a kicker's season is the sum of those.
   */
  kickedFrom?: number;
  /** when it ended in a turnover, whether that was an interception */
  thrownAway: boolean;
}

/** where a game stands when a drive begins */
export interface Opening {
  yardline: number;
  /** this side's lead, since it moves what gets called */
  margin: number;
  secondsLeft: number;
}

/** the seconds inside which a side kicks whatever the down */
const LAST_GASP = 10;
/** and how far out it will still try from, in yards to the goal */
const IN_RANGE = 45;

/**
 * Somewhere to watch what the walk does on fourth down. Set it and the
 * player eval prints kick against punt against go by where the ball is,
 * which is how the decision model was cleared of the extra kicking.
 */
let chose: ((yardline: number, choice: string, toGo: number) => void) | undefined;

/** how far a drive got, and whether it scored, for a check */
export const reached: { best: number; td: boolean }[] = [];
/** what a play gains, by where the ball was */
export const gainedAt = new Map<string, { n: number; yards: number }>();
/** how often the sampled draw gives up, by where the ball is */
export const gaveUpAt = new Map<string, { n: number; pooled: number }>();
/** the fourth downs it went for, by the distance, and how many it made */
export const wentFor = new Map<string, { n: number; made: number }>();
/** how gains on an early down and long are spread, by the call */
export const spread = new Map<string, number>();
export let watchReach = false;
export const watchHowFar = () => { watchReach = true; };

export const watchFourths = (fn: typeof chose) => { chose = fn; };

export function walkDrive(
  startAt: number,
  factors: PlayFactors,
  rules: EndingRules,
  fourth: FourthDown,
  among: string[],
  uniform: () => number,
  clock: ClockRules = CLOCK_DEFAULTS,
  /** who is playing, so the two sides can bend what a play does */
  sides: {
    offence?: string; defence?: string;
    passer?: string; season?: number; week?: number;
    /**
     * What the market says this side's afternoon is worth, as a
     * multiplier near one. The line orders team points at .39 where
     * the walk alone manages .15, and it knows things no simulation
     * ingests, so the walk bends toward it rather than arguing.
     */
    lift?: number;
    /** the passer's own worth, on throws alone */
    passLift?: number;
  } = {},
  /**
   * How long each snap takes. Without one the drive has no length in
   * time, so a game has to be told how many drives it gets instead of
   * playing until the clock runs out.
   */
  ticking?: PlayClock,
  /**
   * Where the game stands. The factors already ask about the score and
   * the clock, and the walk used to answer nil and half time on every
   * drive, so nothing it fitted about either could ever apply.
   */
  opening: Opening = { yardline: startAt, margin: 0, secondsLeft: 1800 },
): FactorDrive {
  const plays: FactorPlay[] = [];
  const state: PlayState = {
    down: 1, toGo: 10, yardline: opening.yardline,
    margin: opening.margin, secondsLeft: opening.secondsLeft,
  };
  let took = 0;
  let sinceLastSnap = 0;
  /**
   * The clock runs between one snap and the next, so a drive of six
   * plays has five gaps rather than six. Charging one after the last
   * play as well made a drive a third too long, and a game lost a
   * third of its possessions.
   */
  const tick = (call: Call, yards: number) => {
    const seconds = ticking
      ? ticking.secondsFor(
          call, yards, state.margin, state.secondsLeft, sides.offence,
        )
      : 0;
    sinceLastSnap = seconds;
    took += seconds;
    state.secondsLeft = Math.max(0, state.secondsLeft - seconds);
  };
  /**
   * What the punt or the kick or the change of possession costs, once
   * the last snap is done with. Twenty seconds is what is left over
   * when the gaps between snaps are taken out of a real drive.
   */
  const ENDS_A_DRIVE = 20;
  const facedAt: number[] = [];
  let thrownAway = false;
  let kickedFrom: number | undefined;
  let deepest = 100;
  const ended = (ending: DriveEnd, handsOverAt: number): FactorDrive => {
    if (watchReach) {
      reached.push({ best: deepest, td: ending === "touchdown" });
    }

    const forReal = Math.max(ENDS_A_DRIVE, took - sinceLastSnap + ENDS_A_DRIVE);
    state.secondsLeft = Math.max(0, state.secondsLeft + sinceLastSnap - ENDS_A_DRIVE);

    return {
      plays, ending, handsOverAt, took: forReal, facedAt, thrownAway,
      kickedFrom,
    };
  };
  // how many snaps there is time for, when this is the last drive of a
  // half. Drawn once, so a drive either has a clock on it or does not.
  const budget = uniform() < clock.isLast
    ? clock.lastLength(uniform)
    : Infinity;

  for (;;) {
    if (plays.length >= Math.min(rules.maxPlays, budget)) {
      return ended("clock", 75);
    }

    /**
     * A kick with the half running out, whatever the down.
     *
     * Nearly one attempt in ten comes on a first, second or third
     * down, and nine in ten of those are inside the last ten seconds
     * of a half, from a median of forty three yards out. Without this
     * the walk never takes them and a kicker loses that tenth.
     */
    /**
     * The clock runs the whole game, so the first half ends as the
     * count passes 1800. The old check watched zero alone, which
     * missed every halftime kick and fired at the end of any game,
     * kicking down twelve with five seconds left. A side takes the
     * game ending kick only when three points win or tie it.
     */
    const halfEnding = state.secondsLeft > 1800 &&
      state.secondsLeft - 1800 <= LAST_GASP;
    const gameEnding = state.secondsLeft <= LAST_GASP &&
      state.margin >= -3 && state.margin <= 0;
    const expiring = (halfEnding || gameEnding) &&
      state.down < 4 && state.yardline <= IN_RANGE;

    if (expiring) {
      kickedFrom = state.yardline;
      const goesOver = rules.kickSucceeds(state.yardline) *
        (rules.kickHere ? rules.kickHere(state.yardline) : 1);

      return uniform() < goesOver
        ? ended("fieldGoal", 75)
        : ended("missedKick", 100 - Math.min(92, state.yardline + 8));
    }

    if (state.down === 4) {
      facedAt.push(state.yardline);
      const choice = fourth.choose(state, uniform);
      chose?.(state.yardline, choice, state.toGo);

      /**
       * Whether the staff actually sends him out. In the cold they go
       * for it instead about a fifth of the time they would otherwise
       * have kicked, which moves a kicker's season more than the
       * weather moves the kick itself.
       */
      const sendsHim = rules.kickAppetite === undefined ||
        rules.kickAppetite >= 1 || uniform() < rules.kickAppetite;

      if (choice === "kick" && sendsHim) {
        // a made kick is followed by a kickoff, a missed one hands the
        // ball over where it was taken from
        kickedFrom = state.yardline;

        const goesOver = rules.kickSucceeds(state.yardline) *
          (rules.kickHere ? rules.kickHere(state.yardline) : 1);

        return uniform() < goesOver
          ? ended("fieldGoal", 75)
          : ended("missedKick", 100 - Math.min(92, state.yardline + 8));
      }

      if (choice === "punt") {
        return ended("punt", rules.puntLands
          ? rules.puntLands(state.yardline, uniform)
          : Math.max(20, Math.min(95, 100 - state.yardline + 40)));
      }
    }

    if (uniform() < rules.penaltyFirstDown) {
      state.yardline = Math.max(1, state.yardline - rules.penaltyYards(uniform));
      state.down = 1;
      state.toGo = Math.min(10, state.yardline);
      plays.push({
        state: { ...state }, call: "pass", player: "", yards: 0, scored: false,
        caught: false,
      });
      tick("pass", 0);
      continue;
    }

    if (preSnapFlag(state, rules, uniform)) {
      plays.push({
        state: { ...state }, call: "pass", player: "", yards: 0, scored: false,
        caught: false,
      });
      tick("pass", 0);
      continue;
    }

    /**
     * The two sides settle the snap before anything else happens. The
     * offence stands somewhere, the defence answers with a shell, and
     * the call, the man it goes to and the yards are all asked of the
     * pair. Drawing the formation after the call let a play be under
     * centre and thrown at the rate of one from the gun.
     */
    const inGun = factors.standsBack
      ? uniform() < factors.standsBack(state, sides.offence)
      : undefined;
    const shell = factors.looksLike && inGun !== undefined
      ? factors.looksLike(state, inGun, sides.defence, uniform)
      : undefined;
    const snap = { ...sides, shell, shotgun: inGun };
    const call: Call = uniform() < factors.runs(state, sides.offence, snap)
      ? "run" : "pass";

    const givenAway = rules.turnoverAt
      ? rules.turnoverAt(state, call)
      : rules.turnoverRate(call);

    if (uniform() < givenAway) {
      // an interception belongs to the man who threw it, and which
      // kind this was is knowable from the call
      thrownAway = call === "pass";
      return ended("turnover", 100 - state.yardline);
    }

    deepest = Math.min(deepest, state.yardline);
    // who it goes to, from the men on the field at this state
    const shares = factors.goesTo(state, call, among, snap);
    let left = uniform();
    let player = among[among.length - 1] ?? "";

    for (const [who, share] of shares) {
      left -= share;

      if (left <= 0) {
        player = who;
        break;
      }
    }

    // his own play when he has enough behind him, whole, and the
    // pooled draw with its multipliers when he does not
    let own = factors.hisOwnPlay
      ? factors.hisOwnPlay(state, call, player, uniform, sides.passer, snap)
      : undefined;

    /**
     * The opponent, heard on the sampled path. A man's own plays were
     * made against every defence he faced, so this week's matchup
     * bends them: a pass defence mostly moves whether the ball was
     * caught rather than how far it went, so on a throw the bend moves
     * catches, and everywhere else it scales yards.
     *
     * It moves them both ways. A strong defence used to turn a catch
     * into an incompletion and a weak one never did the reverse, which
     * took a fifth of a point off the completion rate for nothing.
     */
    if (own && factors.matchup && sides.offence && sides.defence) {
      const bend = factors.matchup(sides.offence, sides.defence, call);

      if (call === "pass" && own.caught && bend < 1 && uniform() > bend) {
        own = { yards: 0, caught: false };
      } else if (call === "pass" && !own.caught && bend > 1 &&
                 uniform() < bend - 1) {
        own = {
          yards: Math.max(1, Math.round(
            factors.gains(state, call, player, uniform, snap),
          )),
          caught: true,
        };
      } else if (own.yards > 0) {
        own = { ...own, yards: Math.round(own.yards * Math.min(bend, 1.2)) };
      }
    }
    const drawn = own
      ? own.yards
      : Math.round(factors.gains(state, call, player, uniform, snap));
    const lifted = (sides.lift ?? 1) *
      (call === "pass" ? sides.passLift ?? 1 : 1);
    let gained = Math.min(
      state.yardline,
      lifted !== 1 && drawn > 0 ? Math.round(drawn * lifted) : drawn,
    );

    /**
     * A pooled draw near the goal is settled against how often plays
     * from this spot really score. The draws come from spots with more
     * room and get capped, so close in they cross more often than
     * sides score, and further out they fall short more often.
     */
    if (!own && state.yardline <= 20 && factors.atTheGoal) {
      gained = factors.atTheGoal(state, call, gained, uniform);
    }

    const scored = state.yardline - gained <= 0;
    const caught = own
      ? own.caught
      : call === "run" || factors.caught(gained, uniform);
    if (watchReach && call === "pass") {
      const y0 = state.yardline;
      const b0 = y0 <= 10 ? "inside 10" : y0 <= 20 ? "11-20" : y0 <= 30 ? "21-30"
        : y0 <= 50 ? "31-50" : y0 <= 70 ? "51-70" : "past 70";
      const seen0 = gaveUpAt.get(b0) ?? { n: 0, pooled: 0 };
      seen0.n++;
      if (!own) seen0.pooled++;
      gaveUpAt.set(b0, seen0);
    }

    if (watchReach) {
      const y = state.yardline;
      const b = y <= 10 ? "inside 10" : y <= 20 ? "11-20" : y <= 30 ? "21-30"
        : y <= 50 ? "31-50" : y <= 70 ? "51-70" : "past 70";
      // counted whole, and again by the call and by which path drew
      // it, since a band that is short can be short on one call alone
      for (const key of [b, `${b}|${call}`, `${b}|${call}|${own ? "own" : "pool"}`]) {
        const seen = gainedAt.get(key) ?? { n: 0, yards: 0 };
        seen.n++;
        seen.yards += gained;
        gainedAt.set(key, seen);
      }

      const early = state.down <= 2 && state.toGo >= 7 && y > 20;
      if (early) {
        const g = gained < 0 ? "loss" : gained === 0 ? "none" : gained <= 3 ? "1-3"
          : gained <= 9 ? "4-9" : gained <= 19 ? "10-19" : "20+";
        const seen = spread.get(`${call}|${g}`) ?? 0;
        spread.set(`${call}|${g}`, seen + 1);
      }

      if (state.down >= 3) {
        const t = state.toGo;
        const d = t <= 1 ? "1" : t <= 2 ? "2" : t <= 3 ? "3" : t <= 5 ? "4-5"
          : t <= 8 ? "6-8" : "9+";
        for (const key of [`${state.down}|${d}`, `${state.down}|${d}|${call}`]) {
          const went = wentFor.get(key) ?? { n: 0, made: 0 };
          went.n++;
          if (gained >= t) went.made++;
          wentFor.set(key, went);
        }
      }
    }

    plays.push({ state: { ...state }, call, player, yards: gained, scored, caught });
    tick(call, gained);
    state.yardline -= gained;

    if (state.yardline <= 0) {
      return ended("touchdown", 75);
    }

    if (gained >= state.toGo) {
      state.down = 1;
      state.toGo = Math.min(10, state.yardline);
      continue;
    }

    state.toGo -= gained;
    state.down++;

    if (state.down > 4) {
      return ended("downs", 100 - state.yardline);
    }
  }
}
