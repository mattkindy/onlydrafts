/**
 * What a questionable starter's news does to a game.
 *
 * The week prices a questionable player at his chance of playing: his
 * projection is multiplied by it and the bottom of his range goes to
 * zero. That is the right number to set a lineup by and the wrong one to
 * plan around, because on Sunday he either plays his whole game or none
 * of it. So each one is priced twice more, once cleared to play and once
 * ruled out, with everybody else as they were.
 *
 * Each player's draws are seeded by who he is, so changing one row moves
 * only his draws, and the gap between the two prices is his news alone
 * rather than noise between two separate runs.
 */

import {
  standingFor, starterState, type WeekPricing,
} from "./matchups.ts";
import type { Matchup } from "./providers.ts";
import { asIfHePlays, asIfHeSits, type SlateRow } from "./slate.ts";

export interface PlayOrSit {
  key: string;
  /** which side of the matchup he starts for, as it orders them */
  side: number;
  /** his chance of playing, as the week priced him */
  chance: number;
  /** the asked side's chance of winning if he plays */
  plays: number;
  /** and if he does not */
  sits: number;
}

/** whether the week marked him down without ruling him out */
const inDoubt = (row: SlateRow | undefined): row is SlateRow =>
  row !== undefined && row.full !== undefined &&
  row.playChance !== undefined && row.playChance > 0 && row.playChance < 1;

/**
 * Every starter on either side still in doubt and yet to kick off, with
 * the asked side's chance of winning if he plays and if he sits, the
 * biggest swing first. Once his game has started the news is in, so he
 * is left out.
 */
export function playOrSitFor(
  matchup: Matchup, at: number, week: WeekPricing,
): PlayOrSit[] {
  const out: PlayOrSit[] = [];
  const seen = new Set<string>();

  matchup.sides.forEach((side, index) => {
    for (const starter of side.starters) {
      const row = week.rows.get(starter.key);

      if (seen.has(starter.key) || !inDoubt(row)) {
        continue;
      }

      seen.add(starter.key);

      const state = starterState(starter, week.rows, week.states, week.lines);

      if (state && state.where !== "pre") {
        continue;
      }

      const priced = (his: SlateRow) => standingFor(matchup, {
        ...week, rows: new Map(week.rows).set(starter.key, his),
      }).odds[at]!;

      out.push({
        key: starter.key,
        side: index,
        chance: row.playChance!,
        plays: priced(asIfHePlays(row)),
        sits: priced(asIfHeSits(row)),
      });
    }
  });

  return out.sort((a, b) =>
    Math.abs(b.plays - b.sits) - Math.abs(a.plays - a.sits));
}
