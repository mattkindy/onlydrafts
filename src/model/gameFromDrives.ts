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
/**
 * What playing at home is worth, as a lift on the home side's plays.
 * The home side outscores its visitor by 2.18 points over 2022 to
 * 2024 and wins 54.8% of the time, and the walk played both sides as
 * though the ground were nobody's.
 */
const AT_HOME = Number(process.env["AT_HOME"] ?? 1.024);
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
  const points: Record<string, number> = { [home.team]: 0, [away.team]: 0 };
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

  const receivedFirst = uniform() < 0.5 ? home : away;
  let withBall = receivedFirst === home ? away : home;
  let against = withBall === home ? away : home;
  let startAt = kickedTo();
  let secondsLeft = settings.length;
  const timeouts: Record<string, number> = { [home.team]: 3, [away.team]: 3 };
  let warningLeft = true;
  let secondHalf = false;

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
      : { yardline: startAt, margin, secondsLeft };
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
      },
      rules.ticking,
      opening,
    );

    possessions.push({
      team: withBall.team, drive, margin, startedAt: startAt,
    });
    points[withBall.team] = points[withBall.team]! + pointsFor(drive);
    drives[withBall.team] = drives[withBall.team]! + 1;
    /**
     * Trailing and late, a side spends its timeouts against the
     * leader's drives. The seconds each play takes were fitted on
     * games that contain those timeouts, so spending one here moves no
     * clock; what it changes is whether the leader can kneel out.
     */
    const took = Math.max(20, drive.took);

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
    startAt = drive.ending === "touchdown" || drive.ending === "fieldGoal"
      ? kickedTo()
      : Math.max(1, Math.min(99, Math.round(drive.handsOverAt)));
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
