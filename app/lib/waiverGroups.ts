/**
 * The wire sorted into the questions a manager actually asks of it.
 *
 * The adds table answers one question, what each free agent does to how
 * often you win, and a list led by that number buries the rest: who to
 * stream at tight end this week, who is worth a bench spot until his bye
 * is over, whose role just changed, and whose points are a fluke. Each
 * group here is a short list with the reason a player is in it.
 */

import {
  outThisWeek, SEASON_OVER, statusOf, type Listed,
} from "./availability.ts";
import { payFor, type Pays, type Player } from "./scoring.ts";
import type { SlateRow } from "./slate.ts";
import { RECENT, ROLE_MOVE, workOf } from "./usage.ts";
import { WORTH_ADDING, type Add } from "./waivers.ts";

export interface Grouped {
  p: Player;
  /** why he is in the group, in a few words */
  why: string;
}

export interface WaiverGroups {
  /** worth a claim now: the best season adds who play this week */
  claim: Grouped[];
  /** worth a bench spot: season value, but no game for him this week */
  stash: Grouped[];
  /** the best free agent lines this week where a lineup streams */
  stream: Grouped[];
  /** snap share up sharply over his last few games */
  rising: Grouped[];
  /** big points lately on a part-time role */
  fluke: Grouped[];
}

/** how many players each group shows */
export const GROUP_SIZE = 4;

/** the positions a manager streams week to week, with how many of each */
const STREAMED: [string, number][] = [["QB", 1], ["TE", 2], ["DEF", 2], ["K", 1]];

/**
 * A rise to under half the snaps is a bigger share of a part-time role, and
 * the move that matters is into the lineup.
 */
const RISEN_TO = 50;

/**
 * A bigger role is only news when it pays. With a line this week he needs
 * this much of one; without one, on a bye or before the week loads, he
 * needs this many carries and targets a game, and a quarterback needs the
 * line, since every starter takes all the snaps.
 */
const RISING_LINE: Record<string, number> = { QB: 14 };
const RISING_LINE_ELSE = 6;
const RISING_TOUCHES = 6;

/**
 * Scoring like a starter on fewer snaps than this is touchdowns doing the
 * work of a role, and touchdowns do not repeat the way snaps do.
 */
const FLUKE_SNAPS = 45;

/** points a game over his recent games that would read as a breakout */
const FLUKE_POINTS = 11;

const pct = (share: number) => `${(100 * share).toFixed(1)}% win chance`;

/**
 * Whether he has no game this week: a bye, or a word on the report that
 * means he does not play. A season-ending word is not a stash, since
 * there is nothing to wait for.
 */
function sitsThisWeek(
  p: Player, week: number | null, status: string | undefined,
): boolean {
  if (week !== null && p.bye === week) {
    return true;
  }

  return outThisWeek(status) && status !== SEASON_OVER;
}

/**
 * His points in each of his latest games, under this league's scoring,
 * oldest first. A week with no line on the board is left out.
 */
function recentPoints(p: Player, pays: Pays, games = RECENT): number[] {
  return (p.weeks ?? [])
    .filter((w) => w.played)
    .slice(-games)
    .map((w) => payFor(w.played!, pays));
}

/**
 * The wire, grouped. `wire` is every free agent the season pricing came
 * back with, best first; `rows` is this week's lines, empty before the
 * week loads; `listed` is the injury report.
 */
export function groupsFor(
  wire: Add[], week: number | null, rows: Map<string, SlateRow>,
  listed: Map<string, Listed>, pays: Pays,
): WaiverGroups {
  const status = (p: Player) => {
    const his = listed.get(p.key);

    return his ? statusOf(his) : undefined;
  };
  // a season-ending injury is priced at nothing already, and is kept out
  // here too in case the report changed after the pricing ran
  const worth = wire.filter((row) =>
    row.added >= WORTH_ADDING && status(row.p) !== SEASON_OVER);

  const claim = worth
    .filter((row) => !sitsThisWeek(row.p, week, status(row.p)))
    .slice(0, GROUP_SIZE)
    .map((row) => ({ p: row.p, why: `+${pct(row.added)} over the season` }));

  const stash = worth
    .filter((row) => sitsThisWeek(row.p, week, status(row.p)))
    .slice(0, GROUP_SIZE)
    .map((row) => ({
      p: row.p,
      why: (week !== null && row.p.bye === week ? "on bye, " : `${status(row.p)}, `) +
        `+${pct(row.added)} over the season`,
    }));

  // this week's lines, for the players who have one and are playing
  const line = (p: Player) => {
    const row = rows.get(p.key);

    return row && !row.bye && !row.ruledOut && !outThisWeek(status(p))
      ? row
      : undefined;
  };

  const stream = STREAMED.flatMap(([position, count]) => wire
    .filter((row) => row.p.position === position && line(row.p))
    .sort((a, b) => line(b.p)!.blend - line(a.p)!.blend)
    .slice(0, count)
    .map((row) => {
      const his = line(row.p)!;

      return {
        p: row.p,
        why: `${his.blend.toFixed(1)} vs ${his.opponent} this week`,
      };
    }));

  const rising = wire
    .flatMap((row) => {
      const work = workOf(row.p);
      const his = rows.get(row.p.key);

      if (!work?.before || work.recent.snaps < RISEN_TO ||
          work.recent.snaps - work.before.snaps < ROLE_MOVE) {
        return [];
      }

      // a jump this week's line says is over, a backup quarterback whose
      // starter is back, is not a role, and nor is one that pays nothing
      const pays = his && !his.bye
        ? his.blend >= (RISING_LINE[row.p.position] ?? RISING_LINE_ELSE)
        : row.p.position !== "QB" &&
          work.recent.carries + work.recent.targets >= RISING_TOUCHES;

      if (!pays) {
        return [];
      }

      return [{ row, gain: work.recent.snaps - work.before.snaps, work }];
    })
    .sort((a, b) => b.gain - a.gain)
    .slice(0, GROUP_SIZE)
    .map(({ row, work }) => ({
      p: row.p,
      why: `snaps ${Math.round(work.before!.snaps)}% → ` +
        `${Math.round(work.recent.snaps)}%`,
    }));

  const fluke = wire
    .flatMap((row) => {
      const work = workOf(row.p);
      const points = recentPoints(row.p, pays);

      if (!work || points.length < RECENT || work.recent.snaps >= FLUKE_SNAPS) {
        return [];
      }

      const average = points.reduce((sum, n) => sum + n, 0) / points.length;

      return average >= FLUKE_POINTS ? [{ row, average, work }] : [];
    })
    .sort((a, b) => b.average - a.average)
    .slice(0, GROUP_SIZE)
    .map(({ row, average, work }) => ({
      p: row.p,
      why: `${average.toFixed(1)} a game on ${Math.round(work.recent.snaps)}% ` +
        "of snaps",
    }));

  return { claim, stash, stream, rising, fluke };
}
