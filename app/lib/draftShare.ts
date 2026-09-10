/**
 * How the draft went, in wins rather than points.
 *
 * Each team's roster is drawn week by week against a typical lineup
 * from this room, the way the draft board prices a pick, and what it
 * wins is set against what the room would have handed the same picks.
 * A team picking third is expected to win more than one picking tenth,
 * so only the difference is the rating.
 *
 * Your own picks are replayed one turn at a time, with the room's
 * picks up to that turn taken off the board, so each one reads what
 * the draft board would have said as you made it.
 */

import { DRAWS } from "./spread.ts";
import type { Player } from "./scoring.ts";
import { waiverBar } from "./replacementPool.ts";
import {
  baselineAcross, baselineFor, drawnPick, FILLS, projectedRoster, takeNowFor,
  typicalWeek, winChance, type WinShare,
} from "./winShare.ts";

export interface Took {
  at: number;
  p: Player;
  kept: boolean;
}

export interface TeamShare {
  owner: string;
  /** how often the roster it drafted wins a week against a typical one */
  wins: number;
  /** how often the roster the room would have handed its picks wins */
  expected: number;
  /** the difference, which is the rating */
  over: number;
  picks: number;
}

export interface Room {
  opponent: number[];
  wire: Record<string, number>;
  draws: number;
}

export function roomFor(
  board: Player[], slots: string[] | null | undefined, teams: number,
  draws = DRAWS,
): Room {
  return {
    opponent: typicalWeek(board, slots, teams, draws),
    wire: waiverBar(board, slots, teams, null),
    draws,
  };
}

/**
 * The roster the room would have handed these picks: the starting seats
 * filled the way the draft board fills them, and the turns after that
 * spent on the best man drawn to still be there. Best by where the room
 * takes him, not by our board, or every side reads below a drafter who
 * agreed with us about everybody.
 */
function marketRoster(
  board: Player[], slots: string[] | null | undefined, picks: number[],
  fill: number,
): Player[] {
  // in the room's order, since it is the room doing the handing
  const priced = [...board].filter((p) => p.adp).sort((a, b) => a.adp! - b.adp!);
  const roster = projectedRoster([], slots, priced, picks, fill);
  const have = new Set(roster.map((p) => p.key));
  const spare = priced.filter((p) => !have.has(p.key));

  for (const at of picks.slice(roster.length)) {
    const him = spare.find((p) => drawnPick(p, fill) >= at);

    if (!him) {
      continue;
    }

    roster.push(him);
    spare.splice(spare.indexOf(him), 1);
  }

  return roster;
}

export function shareTeams(
  teams: { owner: string; took: Took[] }[],
  board: Player[], slots: string[] | null | undefined, room: Room,
): TeamShare[] {
  const fills = Array.from({ length: FILLS }, (_, k) => k);

  return teams
    .map((team) => {
      const men = team.took.map((t) => t.p);
      const picks = [...team.took].map((t) => t.at).sort((a, b) => a - b);
      const wins = winChance(
        baselineFor(men, slots, room.draws, room.wire).total, room.opponent);
      const handed = baselineAcross(
        fills.map((k) => marketRoster(board, slots, picks, k)),
        slots, room.draws, room.wire);
      const expected = winChance(handed.total, room.opponent);

      return {
        owner: team.owner,
        wins,
        expected,
        over: wins - expected,
        picks: team.took.length,
      };
    })
    .sort((a, b) => b.over - a.over);
}

export interface PickShare {
  at: number;
  p: Player;
  kept: boolean;
  /** what taking him at that turn added, as the board would have said */
  share: WinShare;
  /** the man the board would have taken instead, when it was somebody else */
  best: { p: Player; share: WinShare } | null;
}

/** how many of the men left the board is asked about at each turn */
const LOOKED_AT = 40;

export function sharePicks(
  mine: Took[], everyPick: { at: number; p: Player }[], board: Player[],
  slots: string[] | null | undefined, room: Room,
): PickShare[] {
  const turns = [...mine].sort((a, b) => a.at - b.at);

  return turns.map((pick, i) => {
    const gone = new Set(
      everyPick.filter((x) => x.at < pick.at).map((x) => x.p.key));
    const have = turns.slice(0, i).map((t) => t.p);
    const left = board.filter((p) => !gone.has(p.key));
    const worth = takeNowFor(
      have, slots, left, turns.slice(i).map((t) => t.at), room.opponent,
      room.draws, room.wire);
    const share = worth(pick.p);
    let best: PickShare["best"] = null;

    for (const p of left.slice(0, LOOKED_AT)) {
      if (p.key === pick.p.key) {
        continue;
      }

      const his = worth(p);

      if (his.added > share.added && (!best || his.added > best.share.added)) {
        best = { p, share: his };
      }
    }

    return { at: pick.at, p: pick.p, kept: Boolean(pick.kept), share, best };
  });
}
