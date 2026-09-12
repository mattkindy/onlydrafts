/**
 * A game as two sides taking turns until the clock runs out.
 *
 * The walk used to be handed a number of drives drawn from a
 * league-wide list, and a starting spot drawn from another one. Both
 * are constants standing where two particular offences should be: how
 * many drives a game has is how fast the two of them work, and where a
 * drive starts is whatever the last one did.
 *
 * Playing it out gets those for nothing, and gets three more things
 * the walk could not have. The score is known while it is being
 * played, so a side behind throws. The clock is known, so a side ahead
 * runs. And a drive that ends badly leaves the other one a short field.
 */

import { walkDrive, type FactorDrive, type Opening } from "./driveFromFactors.js";
import { standardNormal } from "../sim/rng.js";
import type { PlayerLine } from "./playerWeek.js";
import type { Call, PlayFactors } from "./playFactors.js";
import type { EndingRules, ClockRules } from "./driveFromFactors.js";
import type { DriveEnd } from "./drive.js";
import type { FourthDown } from "../features/fitFourthDown.js";
import type { PlayClock } from "../features/fitPlayClock.js";
import {
  DEFAULT_AFTER_TOUCHDOWN, type AfterTouchdown,
} from "../features/afterTouchdown.js";

/** one side of a game, and everything needed to walk its drives */
export interface Side {
  team: string;
  /** the men who can be given the ball */
  among: string[];
  factors: PlayFactors;
  /** who is throwing, when anyone knows */
  passer?: string;
  /** the market's read on this side's afternoon, near one */
  lift?: number;
  /** what the man throwing it is worth, applied to throws alone */
  passLift?: number;
  /**
   * This side's own drive behaviour, fitted from its drives with the
   * league behind it. The game's rules fill whatever this leaves out,
   * so the kick and venue overrides pass through untouched.
   */
  drives?: Partial<EndingRules>;
}

export interface GameRules {
  rules: EndingRules;
  fourth: FourthDown;
  clock: ClockRules;
  ticking: PlayClock;
  season?: number;
  week?: number;
  /** kick the extra point or go for two, off the six and the clock */
  afterTouchdown?: AfterTouchdown;
}

export interface GameSettings {
  /** seconds in a game, and in a half */
  length: number;
  half: number;
  /** where a kickoff leaves the side receiving it, when not drawn */
  afterKickoff: number;
  /** a drawn kickoff, standing in for the fixed number above */
  kickoffAt?: (uniform: () => number) => number;
  /** the most drives before the loop gives up, as a backstop */
  mostDrives: number;
  /**
   * Tell every drive it is nil apiece with half the clock left, which
   * is what the walk used to be told. Only for finding out whether a
   * change of behaviour comes from the score and the clock or from the
   * two sides taking turns.
   */
  frozen?: boolean;
  /**
   * Where a drive starts, when the caller would rather draw it than
   * take whatever the last drive left. Only for telling the chain
   * apart from everything else.
   */
  startsAt?: (uniform: () => number) => number;
  /**
   * The score, the clock and the ball part way through a game, so the
   * walk can play out the rest of one. Without it every game opens nil
   * apiece with a coin flip.
   */
  from?: GameStart;
}

/**
 * A game in progress, as the walk needs to see it to take over.
 *
 * Every field the opening used to fix is here, so a caller can hand
 * over a scoreboard, a clock and a ball. The coin flip and the opening
 * kickoff are still drawn whether or not this is given, so a state
 * that leaves `withBall` and `yardline` out plays the same game the
 * walk would have played on its own.
 */
export interface GameStart {
  /** the scoreboard, by team */
  points: Record<string, number>;
  secondsLeft: number;
  /** the team with the ball, or the coin flip's answer when left out */
  withBall?: string;
  /** yards to the goal, or the opening kickoff's spot when left out */
  yardline?: number;
  down?: number;
  toGo?: number;
  timeouts: Record<string, number>;
  warningLeft: boolean;
  secondHalf: boolean;
  /**
   * Who took the opening kickoff, since the other side receives to
   * start the second half. Without it the flip decides, which is only
   * right for a state that has not reached half time.
   */
  receivedFirst?: string;
  /**
   * Set when the state is a side about to kick off rather than a side
   * with the ball on a yard line, so the spot is drawn.
   */
  kickoffPending?: boolean;
}

export const GAME_DEFAULTS: GameSettings = {
  length: 3600, half: 1800, afterKickoff: 75, mostDrives: 40,
};

/** who went for two after a touchdown, and what came of it */
export interface TwoPointTry {
  call: Call;
  player: string;
  converted: boolean;
}

export interface Possession {
  team: string;
  drive: FactorDrive;
  /** the score for this side when the drive began */
  margin: number;
  startedAt: number;
  /** set when a touchdown here went for two instead of kicking */
  twoPointTry?: TwoPointTry;
}

export interface PlayedGame {
  possessions: Possession[];
  points: Record<string, number>;
  /** how many drives each side got, which nobody handed it */
  drives: Record<string, number>;
}

/**
 * The stat lines a played game produced, one per man who appeared.
 *
 * Nothing is decided here: each play already says who had it, whether
 * it was caught and what it made, so this only adds them up. The
 * passer gets the passing yards and touchdowns, and an interception
 * when a drive of his ended in one on a throw.
 */
export function linesFrom(
  game: PlayedGame, sides: [Side, Side],
): Map<string, PlayerLine> {
  const lines = new Map<string, PlayerLine>();
  const blank = (playerId: string): PlayerLine => ({
    playerId, played: true,
    passYds: 0, passTd: 0, interceptions: 0, rushYds: 0, rushTd: 0,
    receptions: 0, recYds: 0, recTd: 0, fumblesLost: 0, twoPointConversions: 0,
    carries: 0, targets: 0, passAtt: 0, passCmp: 0,
  });
  const lineOf = (playerId: string) => {
    const already = lines.get(playerId) ?? blank(playerId);
    lines.set(playerId, already);
    return already;
  };
  const passerOf = new Map(sides.map((side) => [side.team, side.passer]));

  for (const one of game.possessions) {
    const passer = passerOf.get(one.team);

    for (const play of one.drive.plays) {
      if (play.call === "run") {
        if (!play.player) {
          continue;
        }

        const his = lineOf(play.player);
        his.carries = (his.carries ?? 0) + 1;
        his.rushYds += play.yards;
        if (play.scored) his.rushTd++;
        continue;
      }

      // a throw nobody was named on is a sack or a ball away, which
      // still costs the offence a down and still counts as an attempt
      if (passer) {
        const threw = lineOf(passer);
        threw.passAtt = (threw.passAtt ?? 0) + 1;
      }

      if (play.player) {
        const aimedAt = lineOf(play.player);
        aimedAt.targets = (aimedAt.targets ?? 0) + 1;
      }

      if (!play.caught || !play.player) {
        continue;
      }

      const his = lineOf(play.player);
      his.receptions++;
      his.recYds += play.yards;
      if (play.scored) his.recTd++;

      if (passer) {
        const threw = lineOf(passer);
        threw.passCmp = (threw.passCmp ?? 0) + 1;
        threw.passYds += play.yards;
        if (play.scored) threw.passTd++;
      }
    }

    if (one.drive.ending === "turnover" && one.drive.thrownAway && passer) {
      lineOf(passer).interceptions++;
    }

    // the try is not one of the drive's own plays, so the man who
    // carried or caught it, and the passer behind a caught one, are
    // credited here instead
    if (one.twoPointTry?.converted && one.twoPointTry.player) {
      const him = lineOf(one.twoPointTry.player);
      him.twoPointConversions = (him.twoPointConversions ?? 0) + 1;

      if (one.twoPointTry.call === "pass" && passer) {
        const threw = lineOf(passer);
        threw.twoPointConversions = (threw.twoPointConversions ?? 0) + 1;
      }
    }
  }

  return lines;
}

const pointsFor = (drive: FactorDrive) =>
  drive.ending === "touchdown" ? 6 : drive.ending === "fieldGoal" ? 3 : 0;

/**
 * What a side scores while the other one has the ball.
 *
 * Only a side's own drives have ever been scored here, and over 2022
 * to 2025 a side takes 0.99 points a game that no drive of its own
 * produced. That is most of the point a game the engine is short, and
 * no drive of the offence's can make it up. The README beside the
 * scripts has where each rate comes from.
 */
const RETURNED_FOR_SIX: Record<DriveEnd, number> = {
  touchdown: 0, fieldGoal: 0, missedKick: 0, clock: 0, downs: 0,
  turnover: Number(process.env["RETURN_TAKEAWAY"] ?? 0.077),
  punt: Number(process.env["RETURN_PUNT"] ?? 0.0039),
};
const RETURNED_KICKOFF = Number(process.env["RETURN_KICKOFF"] ?? 0.0025);
/** off, for telling this apart from what the offence does */
const returns = !process.env["NO_RETURNS"];
const SAFETY_FROM_DEEP = Number(process.env["SAFETY_DEEP"] ?? 0.024);
/** where a drive has to start for the safety rate above to apply */
const DEEP = 90;

/**
 * What the side without the ball took off this possession, if anything.
 *
 * A drive that scored is left alone, since the walk has no fumble
 * returned out of the end zone.
 */
const takenBack = (
  drive: FactorDrive, startedAt: number, uniform: () => number,
): "touchdown" | "safety" | undefined => {
  if (pointsFor(drive) > 0) {
    return undefined;
  }

  if (uniform() < RETURNED_FOR_SIX[drive.ending]) {
    return "touchdown";
  }

  if (startedAt >= DEEP && uniform() < SAFETY_FROM_DEEP) {
    return "safety";
  }

  return undefined;
};

/**
 * Two sides alternating. The side that did not receive to start the
 * game receives to start the second half, as it does really.
 */
/**
 * What playing at home is worth, as a lift on the home side's plays.
 * The home side outscores its visitor by 2.18 points over 2022 to
 * 2024 and wins 54.8% of the time, and the walk played both sides as
 * though the ground were nobody's.
 */
const AT_HOME = Number(process.env["AT_HOME"] ?? 1.024);

/**
 * How far a whole side's afternoon moves, as a fraction of its yards a
 * play. Off, because the swing it adds is shared by every man on the
 * side and so never averages out of an ordering: at its fitted 0.044 it
 * costs the board's first 24 picks .7147 against .7128. The scoreboard
 * has the rest. Zero restores every draw exactly.
 */
const SIDE_DAY = Number(process.env["SIDE_DAY"] ?? 0);

/**
 * What this game is doing to one side, near one. Centred so a side's
 * afternoons still average what its fitted plays say, the same way a
 * man's own tilt is.
 */
export function sideDay(uniform: () => number): number {
  if (SIDE_DAY <= 0) {
    return 1;
  }

  return Math.exp(SIDE_DAY * standardNormal(uniform) - (SIDE_DAY * SIDE_DAY) / 2);
}

/** a kneel with nobody able to stop the clock burns the play clock */
const KNEEL_BURNS = 41;
/** a defensive timeout hands that play's clock back */
const TIMEOUT_SAVES = 39;

export function playGame(
  home: Side,
  away: Side,
  rules: GameRules,
  uniform: () => number,
  settings: GameSettings = GAME_DEFAULTS,
): PlayedGame {
  home = { ...home, lift: (home.lift ?? 1) * AT_HOME };
  away = { ...away, lift: (away.lift ?? 1) / AT_HOME };
  // one draw each, so the two sides get their own afternoon
  const dayOf: Record<string, number> = {
    [home.team]: sideDay(uniform),
    [away.team]: sideDay(uniform),
  };
  home.factors.startsGame?.(uniform);

  if (away.factors !== home.factors) {
    away.factors.startsGame?.(uniform);
  }

  const from = settings.from;
  const points: Record<string, number> = from
    ? { [home.team]: from.points[home.team] ?? 0,
        [away.team]: from.points[away.team] ?? 0 }
    : { [home.team]: 0, [away.team]: 0 };
  const drives: Record<string, number> = { [home.team]: 0, [away.team]: 0 };
  const possessions: Possession[] = [];
  /**
   * Where a kickoff leaves the receiving side. Mostly a touchback to
   * the thirty, the rest a return spread around the same place, set to
   * where drives after kickoffs started in 2024. The old fixed 75 put
   * every kickoff drive five yards behind the played ones.
   */
  const kickedTo = () =>
    settings.kickoffAt
      ? settings.kickoffAt(uniform)
      : uniform() < 0.62 ? 70 : Math.round(60 + uniform() * 20);

  // the flip and the opening kickoff are drawn either way, so a seeded
  // state plays the same game out of the same stream of draws
  const flipped = uniform() < 0.5 ? home : away;
  const receivedFirst = from?.receivedFirst
    ? (from.receivedFirst === home.team ? home : away)
    : flipped;
  const kickedOpeningTo = kickedTo();
  const sideNamed = (team: string) => (team === home.team ? home : away);
  let withBall = from?.withBall
    ? sideNamed(from.withBall)
    : (flipped === home ? away : home);
  let against = withBall === home ? away : home;
  let startAt = from?.kickoffPending
    ? kickedTo()
    : from?.yardline ?? kickedOpeningTo;
  let firstDown = from?.kickoffPending ? undefined : from?.down;
  let firstToGo = from?.kickoffPending ? undefined : from?.toGo;
  let secondsLeft = from?.secondsLeft ?? settings.length;
  const timeouts: Record<string, number> = from
    ? { [home.team]: from.timeouts[home.team] ?? 3,
        [away.team]: from.timeouts[away.team] ?? 3 }
    : { [home.team]: 3, [away.team]: 3 };
  let warningLeft = from ? from.warningLeft : true;
  let secondHalf = from ? from.secondHalf : false;

  while (secondsLeft > 0 && possessions.length < settings.mostDrives) {
    // half time: the clock resets and the other side receives
    if (!secondHalf && secondsLeft <= settings.half) {
      secondHalf = true;
      withBall = receivedFirst;
      against = withBall === home ? away : home;
      startAt = kickedTo();
      timeouts[home.team] = 3;
      timeouts[away.team] = 3;
      warningLeft = true;
      firstDown = undefined;
      firstToGo = undefined;
    }

    if (settings.startsAt) {
      startAt = settings.startsAt(uniform);
    }

    const margin = points[withBall.team]! - points[against.team]!;

    /**
     * A side that leads late kneels the game out when the other side
     * cannot stop the clock. Three kneels burn the play clock each;
     * every timeout the trailing side still has, and the two minute
     * warning if it has not passed, hands one kneel's clock back.
     */
    const stops = timeouts[against.team]! +
      (warningLeft && secondsLeft > 120 ? 1 : 0);
    const kneelable =
      3 * KNEEL_BURNS - stops * TIMEOUT_SAVES;

    if (!settings.frozen && margin > 0 && secondHalf &&
        secondsLeft <= Math.max(6, kneelable)) {
      break;
    }

    const opening: Opening = settings.frozen
      ? { yardline: startAt, margin: 0, secondsLeft: 1800 }
      : {
          yardline: startAt, margin, secondsLeft,
          down: firstDown, toGo: firstToGo,
        };
    firstDown = undefined;
    firstToGo = undefined;
    const itsOwnDrives = withBall.drives
      ? { ...rules.rules, ...withBall.drives }
      : rules.rules;
    const drive = walkDrive(
      startAt, withBall.factors, itsOwnDrives, rules.fourth, withBall.among,
      uniform, rules.clock,
      {
        offence: withBall.team, defence: against.team,
        passer: withBall.passer, season: rules.season, week: rules.week,
        lift: withBall.lift,
        passLift: withBall.passLift,
        day: dayOf[withBall.team],
      },
      rules.ticking,
      opening,
    );

    /**
     * Trailing and late, a side spends its timeouts against the
     * leader's drives. The seconds each play takes were fitted on
     * games that contain those timeouts, so spending one here moves no
     * clock; what it changes is whether the leader can kneel out.
     */
    const took = Math.max(20, drive.took);
    const leftAfter = Math.max(0, secondsLeft - took);

    /**
     * The extra point or the try that replaces it, drawn off the
     * margin with the six already on the board. Neither is one of the
     * drive's own plays, so a converted try is carried on the
     * possession instead and credited once the game is over.
     */
    let scored = pointsFor(drive);
    let twoPointTry: TwoPointTry | undefined;

    if (drive.ending === "touchdown") {
      const afterTd = rules.afterTouchdown ?? DEFAULT_AFTER_TOUCHDOWN;
      const afterMargin = margin + 6;

      if (uniform() < afterTd.goesForTwo(afterMargin, leftAfter)) {
        const state = {
          down: 1, toGo: 2, yardline: 2, margin: afterMargin, secondsLeft: leftAfter,
        };
        const snap = {
          offence: withBall.team, defence: against.team, passer: withBall.passer,
        };
        const call: Call = uniform() < withBall.factors.runs(state, withBall.team, snap)
          ? "run" : "pass";
        const shares = withBall.factors.goesTo(state, call, withBall.among, snap);
        let left = uniform();
        let player = withBall.among[withBall.among.length - 1] ?? "";

        for (const [who, share] of shares) {
          left -= share;

          if (left <= 0) {
            player = who;
            break;
          }
        }

        const converted = uniform() < afterTd.convertRate;
        scored = 6 + (converted ? 2 : 0);
        twoPointTry = { call, player, converted };
      } else {
        scored = 6 + (uniform() < afterTd.extraPointRate ? 1 : 0);
      }
    }

    possessions.push({
      team: withBall.team, drive, margin, startedAt: startAt, twoPointTry,
    });
    points[withBall.team] = points[withBall.team]! + scored;
    drives[withBall.team] = drives[withBall.team]! + 1;

    /**
     * What the other side took while this drive was on, and the
     * kickoff it took back when this one scored. Either touchdown
     * leaves the side it was scored on receiving, so the ball comes
     * back here instead of changing hands.
     */
    const gaveUp = returns ? takenBack(drive, startAt, uniform) : undefined;
    const kickoffGone = returns && scored > 0 &&
      uniform() < RETURNED_KICKOFF;

    if (gaveUp || kickoffGone) {
      const extraPoint = rules.afterTouchdown ?? DEFAULT_AFTER_TOUCHDOWN;
      points[against.team] = points[against.team]! +
        (gaveUp === "safety"
          ? 2
          : 6 + (uniform() < extraPoint.extraPointRate ? 1 : 0));
    }

    if (secondHalf && secondsLeft <= 300 && margin > 0 &&
        timeouts[against.team]! > 0) {
      timeouts[against.team]! -= Math.min(timeouts[against.team]!, 2);
    }

    if (warningLeft && secondsLeft - took < 120) {
      warningLeft = false;
    }

    secondsLeft = Math.max(0, secondsLeft - took);
    // rounded, because the counts are kept against whole yard lines
    // and a start of 52.47 matches none of them, so every lookup
    // widens past the spot it was asked about
    // a score means the other side receives a kickoff, not a spot
    const kickedOff = scored > 0 || gaveUp !== undefined;
    startAt = kickedOff
      ? kickedTo()
      : Math.max(1, Math.min(99, Math.round(drive.handsOverAt)));

    // a touchdown the other side returned, or a kickoff it took back,
    // leaves this side receiving again
    if (gaveUp === "touchdown" || kickoffGone) {
      continue;
    }

    const wasOn = withBall;
    withBall = against;
    against = wasOn;
  }

  /**
   * Overtime, as played overtimes end. Six percent of the walk's games
   * finished level because regulation was all there was; 88 played
   * overtimes from 2019 on end tied 5.7% of the time, by one to three
   * 57%, and by four to six the rest, with nobody winning by more. A
   * short drawn period keeps the game engine out of a format it does
   * not know, and the home lift decides who is likelier to take it.
   */
  if (points[home.team] === points[away.team] && !settings.frozen) {
    const roll = uniform();

    if (roll >= 0.057) {
      const homeShare =
        (home.lift ?? 1) / ((home.lift ?? 1) + (away.lift ?? 1));
      const winner = uniform() < homeShare ? home.team : away.team;
      points[winner]! += uniform() < 0.6 ? 3 : 6;
    }
  }

  return { possessions, points, drives };
}
