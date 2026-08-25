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
import type { PlayerLine } from "./playerWeek.js";
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
  /** the market's read on this side's afternoon, near one */
  lift?: number;
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
  /**
   * Where a drive starts, when the caller would rather draw it than
   * take whatever the last drive left. Only for telling the chain
   * apart from everything else.
   */
  startsAt?: (uniform: () => number) => number;
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
  }

  return lines;
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

    if (settings.startsAt) {
      startAt = settings.startsAt(uniform);
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
        lift: withBall.lift,
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
    // rounded, because the counts are kept against whole yard lines
    // and a start of 52.47 matches none of them, so every lookup
    // widens past the spot it was asked about
    startAt = Math.max(1, Math.min(99, Math.round(drive.handsOverAt)));
    const wasOn = withBall;
    withBall = against;
    against = wasOn;
  }

  return { possessions, points, drives };
}
