/**
 * A week built situation by situation rather than as one pool of
 * touches split up.
 *
 * A man's targets and his hand-offs are drawn separately, because the
 * data says how many of each he got and guessing between them from his
 * position was throwing two fifths of a receiver's work on the ground.
 * Yards per catch and yards per carry are likewise his own numbers in
 * that situation, so a goal-line hand-off is short and a third-and-long
 * target is not.
 *
 * Scores are drawn per touch. A team gets so many snaps near the line,
 * somebody is given the ball, and he finishes or he does not.
 */

import type { Draws, PlayerLine } from "./playerWeek.js";
import { shareDraw } from "./playerWeek.js";
import type { StatLine } from "../scoring/fantasyPoints.js";
import { SITUATIONS, type Situation } from "./situations.js";

export { SITUATIONS, type Situation } from "./situations.js";

/** plays a game an average offence gets in each, from 2021 to 2025 */
export const LEAGUE_PLAYS: Record<Situation, number> = {
  openField: 42.7,
  thirdAndShort: 3.4,
  thirdAndLong: 8.9,
  nearGoal: 10.0,
};

/** how firmly each depth chart stays put, fitted per situation */
export const FIRMNESS: Record<Situation, number> = {
  openField: 10,
  thirdAndShort: 6,
  thirdAndLong: 12,
  nearGoal: 6,
};

/** how much the count of snaps in a situation swings week to week */
export const PLAY_SWING = 0.3;

export interface WeekSettings {
  firmness: Record<Situation, number>;
  playSwing: number;
}

export const DEFAULT_WEEK: WeekSettings = {
  firmness: FIRMNESS,
  playSwing: PLAY_SWING,
};

type BySituation = Record<Situation, number>;

export interface SituationalRole {
  playerId: string;
  position: string;
  /** share of his team's plays there that are thrown his way */
  targetShare: BySituation;
  /** share that are handed to him */
  carryShare: BySituation;
  catchRate: BySituation;
  yardsPerCatch: BySituation;
  yardsPerCarry: BySituation;
  /** how often a catch, or a hand-off, ends in the end zone */
  scoresPerCatch: BySituation;
  scoresPerCarry: BySituation;
  /** how much his yardage swings from one touch to the next */
  yardSwing: number;
  availability: number;
}

export interface SituationalTeam {
  plays: BySituation;
}

/**
 * What the schedule says about one particular week. A big favourite
 * runs more and reaches the goal line more often; a team in a shootout
 * gets more of everything; a gale takes throws away.
 */
export interface GameContext {
  /** points by which this team is favoured, negative as an underdog */
  favouredBy: number;
  /** what the game is expected to total */
  total: number;
  /** miles per hour, zero under a roof */
  wind: number;
  /** how soft the defence has been to this position, 1 is average */
  opponent: number;
}

const NEUTRAL_TOTAL = 45;

/**
 * Bends a team's week to the game in front of it, from the effects
 * measured over 2716 team-games: a big underdog throws on 56% of its
 * plays and a big favourite on 52%, a game expected to reach the high
 * forties adds four pass attempts, and wind past 15mph takes two and a
 * half away. Scoring chances follow the total.
 */
export function forGame(team: SituationalTeam, game: GameContext): SituationalTeam {
  const scoring = 1 + (game.total - NEUTRAL_TOTAL) * 0.02;
  const pace = 1 + (game.total - NEUTRAL_TOTAL) * 0.005;
  const gale = Math.max(0, game.wind - 8) * 0.004;
  // being ahead means running, which mostly happens in the open field
  const leading = game.favouredBy * 0.004;

  return {
    plays: {
      openField: team.plays.openField * pace * (1 + leading) * game.opponent,
      thirdAndShort: team.plays.thirdAndShort * pace * (1 + leading),
      thirdAndLong: team.plays.thirdAndLong * pace * (1 - leading) * (1 + gale),
      nearGoal: team.plays.nearGoal * scoring * game.opponent,
    },
  };
}

const BLANK: StatLine = {
  passYds: 0, passTd: 0, interceptions: 0, rushYds: 0, rushTd: 0,
  receptions: 0, recYds: 0, recTd: 0, fumblesLost: 0, twoPointConversions: 0,
};

/**
 * One week for a whole offence. Every situation is drawn on its own,
 * so a back who only appears at the goal line and a receiver who only
 * appears on third and long both come out right.
 */
export function simulateSituationalWeek(
  team: SituationalTeam,
  roster: SituationalRole[],
  draws: Draws,
  settings: WeekSettings = DEFAULT_WEEK,
): PlayerLine[] {
  const active = roster.map((player) => draws.uniform() < player.availability);
  const lines: PlayerLine[] = roster.map((player, i) => ({
    ...BLANK, playerId: player.playerId, played: active[i]!,
  }));

  for (const situation of SITUATIONS) {
    const plays = Math.max(
      0,
      Math.round(
        team.plays[situation] *
          Math.max(0.3, 1 + draws.normal() * settings.playSwing),
      ),
    );

    if (plays === 0) {
      continue;
    }

    // the throwing and the running are separate pools, and the men in
    // each compete only with the others in that one
    for (const kind of ["target", "carry"] as const) {
      const own = (p: SituationalRole) =>
        kind === "target" ? p.targetShare[situation] : p.carryShare[situation];
      const wanted = roster.map((p, i) => (active[i] ? own(p) : 0));
      const rest = Math.max(0, 1 - roster.reduce((sum, p) => sum + own(p), 0));
      const shares = shareDraw([...wanted, rest], settings.firmness[situation], draws);

      for (let i = 0; i < roster.length; i++) {
        if (!active[i]) {
          continue;
        }

        const player = roster[i]!;
        const count = Math.round(plays * shares[i]!);

        for (let n = 0; n < count; n++) {
          const swing = () => Math.max(0, 1 + draws.normal() * player.yardSwing);

          if (kind === "target") {
            if (draws.uniform() >= player.catchRate[situation]) {
              continue;
            }

            lines[i]!.receptions++;
            lines[i]!.recYds += player.yardsPerCatch[situation] * swing();

            if (draws.uniform() < player.scoresPerCatch[situation]) {
              lines[i]!.recTd++;
            }
          } else {
            lines[i]!.rushYds += player.yardsPerCarry[situation] * swing();

            if (draws.uniform() < player.scoresPerCarry[situation]) {
              lines[i]!.rushTd++;
            }
          }
        }
      }
    }
  }

  return lines;
}
