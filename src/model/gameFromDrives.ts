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
import type { PlayFactors } from "./playFactors.js";
import type { EndingRules, ClockRules } from "./driveFromFactors.js";
import type { FourthDown } from "../features/fitFourthDown.js";
import type { PlayClock } from "../features/fitPlayClock.js";

/** one side of a game, and everything needed to walk its drives */
export interface Side {
  team: string;
  /** the men who can be given the ball */
  among: string[];
  factors: PlayFactors;
  /** who is throwing, when anyone knows */
  passer?: string;
}

export interface GameRules {
  rules: EndingRules;
  fourth: FourthDown;
  clock: ClockRules;
  ticking: PlayClock;
  season?: number;
  week?: number;
}

export interface GameSettings {
  /** seconds in a game, and in a half */
  length: number;
  half: number;
  /** where a kickoff leaves the side receiving it */
  afterKickoff: number;
  /** the most drives before the loop gives up, as a backstop */
  mostDrives: number;
  /**
   * Tell every drive it is nil apiece with half the clock left, which
   * is what the walk used to be told. Only for finding out whether a
   * change of behaviour comes from the score and the clock or from the
   * two sides taking turns.
   */
  frozen?: boolean;
}

export const GAME_DEFAULTS: GameSettings = {
  length: 3600, half: 1800, afterKickoff: 75, mostDrives: 40,
};

export interface Possession {
  team: string;
  drive: FactorDrive;
  /** the score for this side when the drive began */
  margin: number;
  startedAt: number;
}

export interface PlayedGame {
  possessions: Possession[];
  points: Record<string, number>;
  /** how many drives each side got, which nobody handed it */
  drives: Record<string, number>;
}

const pointsFor = (drive: FactorDrive) =>
  drive.ending === "touchdown" ? 7 : drive.ending === "fieldGoal" ? 3 : 0;

/**
 * Two sides alternating. The side that did not receive to start the
 * game receives to start the second half, as it does really.
 */
export function playGame(
  home: Side,
  away: Side,
  rules: GameRules,
  uniform: () => number,
  settings: GameSettings = GAME_DEFAULTS,
): PlayedGame {
  const points: Record<string, number> = { [home.team]: 0, [away.team]: 0 };
  const drives: Record<string, number> = { [home.team]: 0, [away.team]: 0 };
  const possessions: Possession[] = [];
  const receivedFirst = uniform() < 0.5 ? home : away;
  let withBall = receivedFirst === home ? away : home;
  let against = withBall === home ? away : home;
  let startAt = settings.afterKickoff;
  let secondsLeft = settings.length;
  let secondHalf = false;

  while (secondsLeft > 0 && possessions.length < settings.mostDrives) {
    // half time: the clock resets and the other side receives
    if (!secondHalf && secondsLeft <= settings.half) {
      secondHalf = true;
      withBall = receivedFirst;
      against = withBall === home ? away : home;
      startAt = settings.afterKickoff;
    }

    const margin = points[withBall.team]! - points[against.team]!;
    const opening: Opening = settings.frozen
      ? { yardline: startAt, margin: 0, secondsLeft: 1800 }
      : { yardline: startAt, margin, secondsLeft };
    const drive = walkDrive(
      startAt, withBall.factors, rules.rules, rules.fourth, withBall.among,
      uniform, rules.clock,
      {
        offence: withBall.team, defence: against.team,
        passer: withBall.passer, season: rules.season, week: rules.week,
      },
      rules.ticking,
      opening,
    );

    possessions.push({
      team: withBall.team, drive, margin, startedAt: startAt,
    });
    points[withBall.team] = points[withBall.team]! + pointsFor(drive);
    drives[withBall.team] = drives[withBall.team]! + 1;
    secondsLeft = Math.max(0, secondsLeft - Math.max(20, drive.took));
    startAt = Math.max(1, Math.min(99, drive.handsOverAt));
    const wasOn = withBall;
    withBall = against;
    against = wasOn;
  }

  return { possessions, points, drives };
}
