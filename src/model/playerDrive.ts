/**
 * A drive as what the players on it produced.
 *
 * The other walk had this backwards. It drew a play's yards from a
 * league wide pool, moved the chains, and only afterwards picked a name
 * to credit, so every back gained the same yards and players differed
 * only in how often they were chosen.
 *
 * Here a snap is somebody carrying or catching it, and what he gains is
 * drawn against his own rate. The drive is then whatever those snaps
 * add up to, so its length and how it ends are results rather than
 * things fitted directly.
 */

import type { DriveEnd, PlayType } from "./drive.js";
import { KICK_LENGTH } from "./drive.js";
import type { FittedDrives } from "../features/driveRules.js";
import type { Draws, PlayerLine } from "./playerWeek.js";
import type { SituationalRole } from "./situationalWeek.js";
import { ROLLS_UP_TO, situationOf } from "./situations.js";

/** how often an average target is caught, when nobody's own rate is known */
export const LEAGUE_CATCH_RATE = 0.64;

export interface PlayerDrivePlay {
  down: number;
  toGo: number;
  yardline: number;
  type: PlayType;
  yards: number;
  /** who had it, empty on a sack or when nobody could be chosen */
  playerId: string;
  caught: boolean;
  scored: boolean;
}

export interface PlayerDrive {
  plays: PlayerDrivePlay[];
  ending: DriveEnd;
  handsOverAt: number;
}

/** one man, drawn in proportion to his share of this kind of work */
function whoGetsIt(
  roster: SituationalRole[],
  available: boolean[],
  share: (player: SituationalRole) => number,
  draws: Draws,
): number {
  let total = 0;

  for (let i = 0; i < roster.length; i++) {
    if (available[i]) {
      total += Math.max(0, share(roster[i]!));
    }
  }

  if (total <= 0) {
    return -1;
  }

  let left = draws.uniform() * total;

  for (let i = 0; i < roster.length; i++) {
    if (!available[i]) {
      continue;
    }

    left -= Math.max(0, share(roster[i]!));

    if (left <= 0) {
      return i;
    }
  }

  return -1;
}

/**
 * The league's yardage for this kind of play, stretched to the man who
 * made it.
 *
 * Drawing from the pool keeps the shape, which is the part that matters:
 * a fifth of passes gain ten or more and one in twelve gains twenty,
 * and no tidy curve gives that and the eight percent that lose ground.
 * Scaling by his own rate is what makes it his. A loss is left alone,
 * since a better player does not lose more when he loses.
 */
function stretch(drawn: number, ownRate: number, leagueRate: number): number {
  if (drawn <= 0 || leagueRate <= 0 || ownRate <= 0) {
    return drawn;
  }

  return drawn * (ownRate / leagueRate);
}

export function simulatePlayerDrive(
  startAt: number,
  roster: SituationalRole[],
  available: boolean[],
  rules: FittedDrives,
  draws: Draws,
): PlayerDrive {
  const plays: PlayerDrivePlay[] = [];
  const state = { down: 1, toGo: 10, yardline: startAt, plays: 0 };

  for (;;) {
    if (state.plays >= rules.maxPlays) {
      return { plays, ending: "clock", handsOverAt: 75 };
    }

    if (state.down === 4 && !rules.goesForIt(state.yardline, state.toGo, draws.uniform)) {
      if (KICK_LENGTH(state.yardline) <= 62 && state.yardline <= 40) {
        return draws.uniform() < rules.kickSucceeds(state.yardline)
          ? { plays, ending: "fieldGoal", handsOverAt: 75 }
          : { plays, ending: "missedKick", handsOverAt: 100 - state.yardline };
      }

      return {
        plays, ending: "punt",
        handsOverAt: rules.puntLands(state.yardline, draws.uniform),
      };
    }

    if (draws.uniform() < rules.penaltyFirstDown) {
      state.yardline = Math.max(1, state.yardline - rules.penaltyYards(draws.uniform));
      state.down = 1;
      state.toGo = Math.min(10, state.yardline);
      state.plays++;
      continue;
    }

    const type: PlayType =
      draws.uniform() < rules.runRate(state.down, state.toGo) ? "run" : "pass";

    if (draws.uniform() < rules.turnoverRate(type)) {
      return { plays, ending: "turnover", handsOverAt: 100 - state.yardline };
    }

    // the throw never gets away, which costs yards and a down
    if (type === "pass" && draws.uniform() < rules.sackRate) {
      const lost = Math.round(rules.sackYards(draws.uniform));
      plays.push({
        down: state.down, toGo: state.toGo, yardline: state.yardline,
        type, yards: lost, playerId: "", caught: false, scored: false,
      });
      state.plays++;
      state.yardline -= lost;
      state.toGo -= lost;
      state.down++;

      if (state.down > 4) {
        return { plays, ending: "downs", handsOverAt: 100 - state.yardline };
      }

      continue;
    }

    const situation = ROLLS_UP_TO[
      situationOf(state.down, state.toGo, state.yardline, 0, 3600)
    ];
    const who = whoGetsIt(
      roster, available,
      (p) => (type === "run" ? p.carryShare[situation] : p.targetShare[situation]),
      draws,
    );
    const player = who === -1 ? undefined : roster[who];
    let yards = 0;
    let caught = type === "run";

    if (!player) {
      yards = rules.yardsFor(type, state.down, state.toGo, draws.uniform);
    } else if (type === "run") {
      yards = stretch(
        rules.yardsFor(type, state.down, state.toGo, draws.uniform),
        player.yardsPerCarry[situation] || rules.means.carry,
        rules.means.carry,
      );
    } else {
      // The catch is decided here, so the yards have to come from the
      // passes that were caught. Drawing from all of them would drop a
      // third of the throws twice over.
      caught = draws.uniform() <
        (player.catchRate[situation] || LEAGUE_CATCH_RATE);
      yards = caught
        ? stretch(
            rules.caughtYards(state.down, state.toGo, draws.uniform),
            player.yardsPerCatch[situation] || rules.means.caught,
            rules.means.caught,
          )
        : 0;
    }

    yards = Math.min(state.yardline, Math.round(yards));
    const scored = state.yardline - yards <= 0;
    plays.push({
      down: state.down, toGo: state.toGo, yardline: state.yardline,
      type, yards, playerId: player ? player.playerId : "", caught, scored,
    });
    state.plays++;
    state.yardline -= yards;

    if (state.yardline <= 0) {
      return { plays, ending: "touchdown", handsOverAt: 75 };
    }

    if (yards >= state.toGo) {
      state.down = 1;
      state.toGo = Math.min(10, state.yardline);
      continue;
    }

    state.toGo -= yards;
    state.down++;

    if (state.down > 4) {
      return { plays, ending: "downs", handsOverAt: 100 - state.yardline };
    }
  }
}

/**
 * The stat lines these drives produced.
 *
 * Nothing is decided here. Each snap already says who had it and what
 * he gained, so this only adds them up, which is the difference from
 * crediting a man afterwards for yards chosen without him.
 */
export function linesFrom(
  drives: PlayerDrive[],
  roster: SituationalRole[],
  available: boolean[],
  quarterback: string,
): PlayerLine[] {
  const lines: PlayerLine[] = roster.map((player, i) => ({
    playerId: player.playerId, played: available[i]!,
    passYds: 0, passTd: 0, interceptions: 0, rushYds: 0, rushTd: 0,
    receptions: 0, recYds: 0, recTd: 0, fumblesLost: 0, twoPointConversions: 0,
  }));
  const spot = new Map(roster.map((player, i) => [player.playerId, i]));
  const passer = spot.get(quarterback);

  for (const drive of drives) {
    for (const play of drive.plays) {
      const who = spot.get(play.playerId);

      if (who === undefined) {
        continue;
      }

      if (play.type === "run") {
        lines[who]!.rushYds += play.yards;
        if (play.scored) lines[who]!.rushTd++;
        continue;
      }

      if (!play.caught) {
        continue;
      }

      lines[who]!.receptions++;
      lines[who]!.recYds += play.yards;

      if (passer !== undefined) {
        lines[passer]!.passYds += play.yards;
      }

      if (play.scored) {
        lines[who]!.recTd++;
        if (passer !== undefined) lines[passer]!.passTd++;
      }
    }
  }

  return lines;
}
