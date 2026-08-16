/**
 * A week built situation by situation rather than as one pool of
 * touches split up.
 *
 * The difference shows in touchdowns. Dividing a team's expected
 * scores by a season share treats a score as a fraction of a total.
 * Here a team gets so many snaps at the goal line, someone is handed
 * the ball on each, and he scores or he does not, which is how they
 * happen and why they arrive in lumps.
 *
 * It also lets the model answer questions a pooled draw cannot: who
 * gets the ball on third and one, and what changes when the man who
 * usually does is out.
 */

import type { Draws, PlayerLine } from "./playerWeek.js";
import { shareDraw } from "./playerWeek.js";
import type { StatLine } from "../scoring/fantasyPoints.js";
import { SITUATIONS, type Situation } from "./situations.js";

export { SITUATIONS, type Situation } from "./situations.js";

/** plays a game an average offence gets in each, from 2021 to 2025 */
export const LEAGUE_PLAYS: Record<Situation, number> = {
  openField: 39.9,
  thirdAndShort: 2.7,
  thirdAndLong: 9.5,
  nearGoal: 10.0,
};

/** how firmly each depth chart stays put, fitted per situation */
const FIRMNESS: Record<Situation, number> = {
  openField: 10,
  thirdAndShort: 6,
  thirdAndLong: 12,
  nearGoal: 6,
};

export interface SituationalRole {
  playerId: string;
  position: string;
  /** share of his team's plays in each situation that come to him */
  shareIn: Record<Situation, number>;
  /** how often a touch there ends in the end zone */
  finishIn: Record<Situation, number>;
  yardsPerTouch: Record<Situation, number>;
  catchRate: number;
  availability: number;
}

export interface SituationalTeam {
  /** plays this offence gets in each situation this week */
  plays: Record<Situation, number>;
  /** share of its plays that are passes, from the line and the weather */
  passShare: number;
}

const BLANK: StatLine = {
  passYds: 0, passTd: 0, interceptions: 0, rushYds: 0, rushTd: 0,
  receptions: 0, recYds: 0, recTd: 0, fumblesLost: 0, twoPointConversions: 0,
};

/**
 * One week for a whole offence. Every situation is drawn on its own,
 * so a back who only appears at the goal line and a receiver who only
 * appears on third and long both come out right, and neither has to be
 * described by a season average that mixes the two.
 */
export function simulateSituationalWeek(
  team: SituationalTeam,
  roster: SituationalRole[],
  draws: Draws,
): PlayerLine[] {
  const active = roster.map((player) => draws.uniform() < player.availability);
  const lines = roster.map((player) => ({
    ...BLANK, playerId: player.playerId, played: active[roster.indexOf(player)] ?? false,
  })) as PlayerLine[];

  roster.forEach((_, i) => { lines[i]!.played = active[i]!; });

  for (const situation of SITUATIONS) {
    // the offence has a good or bad day at getting there at all
    const plays = Math.max(
      0,
      Math.round(team.plays[situation] * Math.max(0.3, 1 + draws.normal() * 0.3)),
    );

    if (plays === 0) {
      continue;
    }

    const wanted = roster.map((p, i) => (active[i] ? p.shareIn[situation] : 0));
    const rest = Math.max(0, 1 - roster.reduce((sum, p) => sum + p.shareIn[situation], 0));
    const shares = shareDraw([...wanted, rest], FIRMNESS[situation], draws);

    for (let i = 0; i < roster.length; i++) {
      if (!active[i]) {
        continue;
      }

      const player = roster[i]!;
      const touches = Math.round(plays * shares[i]!);

      // A receiver's touch is a target; a back's is mostly a hand-off.
      // Routing them by a coin weighted on the team's pass share sent
      // two fifths of every receiver's work to the ground.
      const airShare = player.position === "RB" ? 0.22 : 0.97;

      for (let touch = 0; touch < touches; touch++) {
        const throughAir = draws.uniform() < airShare;

        if (throughAir && draws.uniform() >= player.catchRate) {
          continue;
        }

        // yards per touch swing far more than the count of them does
        const yards = Math.max(
          0,
          player.yardsPerTouch[situation] * Math.max(0, 1 + draws.normal() * 0.8),
        );

        if (throughAir) {
          lines[i]!.receptions++;
          lines[i]!.recYds += yards;
        } else {
          lines[i]!.rushYds += yards;
        }

        // a score is this touch finishing, not a slice of a team total
        if (draws.uniform() < player.finishIn[situation]) {
          if (throughAir) {
            lines[i]!.recTd++;
          } else {
            lines[i]!.rushTd++;
          }
        }
      }
    }
  }

  return lines;
}
