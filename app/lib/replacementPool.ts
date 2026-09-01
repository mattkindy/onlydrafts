/**
 * What you would actually get instead of him, which is a different
 * question at different positions.
 *
 * A back you draft, you keep, and the backs on waivers are poor, so the
 * last man the league starts is a fair stand-in. A kicker or a defence
 * you replace any week you like, so what you weigh him against is the
 * best man nobody rosters plus whatever choosing weekly on the matchup
 * adds. That comes out far above the last starter's average, which is
 * why a defence looks worth a sixth-round pick when it is not. How many
 * are rostered comes off the league where we have it, so a room where
 * everyone keeps two defences moves it.
 */

import type { League, Roster } from "./providers.ts";
import type { Player } from "./scoring.ts";

/** the positions people swap out after a bad week */
export const STREAMED = new Set(["K", "DEF"]);

/**
 * What choosing one every week on the betting line adds over keeping
 * the best one left, in points a game.
 *
 * Played out over 2021 to 2025: a defence held gives 5.31 a game and
 * one chosen weekly gives 7.61. That 2.30 is what a lone streamer
 * collects, and it decays as the room crowds in, since only one team
 * takes the softest matchup and the rest work down the list: 1.43 with
 * six of them at it, 0.43 with all twelve. Six is the middle of the
 * room and what this uses, because assuming you are the only one
 * paying attention is the optimistic end of a range.
 *
 * A kicker never clears his own noise, so he keeps the plain bar.
 */
const STREAMING_GAIN: Record<string, number> = { DEF: 1.4, K: 0 };

/**
 * How many of each position a team keeps before anyone has drafted.
 * Teams take a kicker and a defence and almost never a second, so the
 * count is close to one a team, and the pool that leaves is what the
 * number actually turns on.
 */
const KEPT_BEFORE_A_DRAFT: Record<string, number> = { K: 1, DEF: 1 };

/** how many at each position the league has on its rosters right now */
export function rosteredCounts(rosters: Roster[]): Record<string, number> {
  const tally: Record<string, number> = {};

  for (const team of rosters) {
    for (const man of team.keys) {
      const where = man.pos;

      if (!where) {
        continue;
      }

      tally[where] = (tally[where] ?? 0) + 1;
    }
  }

  return tally;
}

/**
 * How many are rostered, from the league when it has told us and from
 * the roster arithmetic when it has not. Before a draft nobody owns
 * anybody, so the counts are nought and the settings answer instead.
 */
export function keptAt(
  position: string, teams: number, rosters: Roster[] | null | undefined,
): number {
  const live = rosters?.length ? rosteredCounts(rosters)[position] ?? 0 : 0;

  if (live > 0) {
    return live;
  }

  return (KEPT_BEFORE_A_DRAFT[position] ?? 1) * teams;
}

/**
 * What the wire gives you at a position you replace week to week: the
 * best man nobody rosters, plus what choosing weekly on the matchup is
 * worth on top of him.
 *
 * The gain is added rather than read as the best week the pool happened
 * to produce. A maximum over what they did scores the choice with
 * hindsight, which nobody has, and it priced a defence off waivers at
 * 9.15 a game where a person choosing weekly gets 7.61.
 */
export function offWaivers(
  men: Player[], position: string, teams: number,
  rosters: Roster[] | null | undefined,
): number | null {
  const kept = keptAt(position, teams, rosters);
  const best = men
    .filter((p) => p.position === position)
    .sort((a, b) => (b.ppg ?? 0) - (a.ppg ?? 0))
    .slice(kept)[0]?.ppg;

  if (best === undefined) {
    return null;
  }

  return best + (STREAMING_GAIN[position] ?? 0);
}

export interface PoolInput {
  men: Player[];
  teams: number;
  rosters?: Roster[] | null;
  /** the last man the league starts at each position, the old measure */
  lastStarter: Record<string, number>;
}

/**
 * The bar every position is measured against. Streamed positions get
 * the best off waivers, everybody else keeps the last man the league
 * starts, since that is who you would be playing instead of him.
 */
export function replacementBar(input: PoolInput): Record<string, number> {
  const bar = { ...input.lastStarter };

  for (const position of STREAMED) {
    const best = offWaivers(
      input.men, position, input.teams, input.rosters,
    );

    if (best !== null) {
      bar[position] = Number(best.toFixed(2));
    }
  }

  return bar;
}

/** the rosters a league knows about, when it has any */
export const rostersOf = (league: League | null | undefined) =>
  league?.allRosters?.length ? league.allRosters : null;
