/**
 * Who gets credit for the plays a drive produced.
 *
 * The drive walk decides what happens: a nine yard gain on second and
 * six, then an incompletion, then a punt. It does not say who carried
 * it or who it was thrown to, so nothing it produces can become a stat
 * line. This puts a man on each play.
 *
 * The drive's yardage is left alone. It came from what such plays
 * really gain and it is what moved the chains, so changing it here
 * would give a player yards his own drive never had.
 */

import type { Drive, DrivePlay } from "./drive.js";
import type { Draws, PlayerLine } from "./playerWeek.js";
import type { SituationalRole } from "./situationalWeek.js";
import { ROLLS_UP_TO, situationOf, type Situation } from "./situations.js";
import type { StatLine } from "../scoring/fantasyPoints.js";

const BLANK: StatLine = {
  passYds: 0, passTd: 0, interceptions: 0, rushYds: 0, rushTd: 0,
  receptions: 0, recYds: 0, recTd: 0, fumblesLost: 0, twoPointConversions: 0,
};

/**
 * Which situation a snap belongs to. The drive does not track the score
 * or the clock, which only decide between two labels that both roll up
 * to open field, so nothing turns on the placeholders.
 */
export function situationForPlay(play: DrivePlay): Situation {
  return ROLLS_UP_TO[
    situationOf(play.state.down, play.state.toGo, play.state.yardline, 0, 3600)
  ];
}

/** one man, drawn in proportion to his share of this kind of work */
function whoGetsIt(
  roster: SituationalRole[],
  active: boolean[],
  share: (player: SituationalRole) => number,
  draws: Draws,
): number {
  let total = 0;

  for (let i = 0; i < roster.length; i++) {
    if (active[i]) {
      total += Math.max(0, share(roster[i]!));
    }
  }

  if (total <= 0) {
    return -1;
  }

  let left = draws.uniform() * total;

  for (let i = 0; i < roster.length; i++) {
    if (!active[i]) {
      continue;
    }

    left -= Math.max(0, share(roster[i]!));

    if (left <= 0) {
      return i;
    }
  }

  return -1;
}

export interface AttributionSettings {
  /** who is under centre, since the passing goes to him */
  quarterback: string;
}

/**
 * A week of drives turned into stat lines.
 *
 * A pass is read from what it gained, which separates the three cases
 * closely enough: over 2022 to 2025, 34.4% of pass plays gained nothing
 * against a league incompletion rate near 35%, and 8.2% lost ground
 * against a sack rate near 8%.
 */
export function attributeDrives(
  drives: Drive[],
  roster: SituationalRole[],
  draws: Draws,
  settings: AttributionSettings,
): PlayerLine[] {
  const active = roster.map((player) => draws.uniform() < player.availability);
  const lines: PlayerLine[] = roster.map((player, i) => ({
    ...BLANK, playerId: player.playerId, played: active[i]!,
  }));
  const passer = roster.findIndex((p) => p.playerId === settings.quarterback);

  for (const drive of drives) {
    for (let n = 0; n < drive.plays.length; n++) {
      const play = drive.plays[n]!;
      const situation = situationForPlay(play);
      // the last play of a drive that reached the end zone is the one
      // that scored, and nothing else on the drive did
      const scored = drive.ending === "touchdown" && n === drive.plays.length - 1;

      if (play.type === "run") {
        const who = whoGetsIt(
          roster, active, (p) => p.carryShare[situation], draws,
        );

        if (who === -1) {
          continue;
        }

        lines[who]!.rushYds += play.yards;

        if (scored) {
          lines[who]!.rushTd++;
        }

        continue;
      }

      // a sack is the quarterback's alone and is worth nothing to him
      if (play.yards < 0) {
        continue;
      }

      const who = whoGetsIt(
        roster, active, (p) => p.targetShare[situation], draws,
      );

      if (who === -1) {
        continue;
      }

      // thrown at him and not caught: he was targeted, and that is all
      if (play.yards === 0) {
        continue;
      }

      lines[who]!.receptions++;
      lines[who]!.recYds += play.yards;

      if (passer !== -1) {
        lines[passer]!.passYds += play.yards;
      }

      if (scored) {
        lines[who]!.recTd++;

        if (passer !== -1) {
          lines[passer]!.passTd++;
        }
      }
    }
  }

  return lines;
}
