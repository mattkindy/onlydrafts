/**
 * What share of his offence's plays a man is going to get.
 *
 * A share is touches over the plays his team ran, so it says how much
 * of the work he took without saying how much work there was. Volume
 * is most of what a fantasy season is: giving every man the touches
 * his position usually gets, at the league's yards, ranks a season at
 * .888, and adding each man's own efficiency only reaches .898.
 *
 * The projection has two parts. What a man has shown, and then the
 * competition: a position group has a budget of its offence to give
 * out and the men there divide it between them.
 */

import { loadPlayerStats, loadWeeklyRosters } from "../data/nflverse.js";
import type { DraftPick } from "../data/draftPicks.js";
import { divideAmong, type CompetitionSettings } from "./shareCompetition.js";

/** the positions that compete for touches; a quarterback does not */
export const SHARING_POSITIONS = ["RB", "WR", "TE"];

/** a season a man already has behind him */
export interface PastYear {
  playerId: string;
  position: string;
  team: string;
  games: number;
  touches: number;
  /** touches over the plays his offence ran */
  share: number;
}

/** who is expected to be where, going into the season being projected */
export interface RosterMan {
  playerId: string;
  position: string;
  team: string;
}

export interface ShareSettings {
  /**
   * How the seasons behind him are weighted, most recent first. Swept
   * on 2025, where one season alone ranked .747 and three at these
   * weights .762. The gain from the older seasons is small and steady.
   */
  weights: number[];
  /**
   * Whether the group divides its own team's budget or the league's.
   * A passing offence has more to give its receivers, which is worth
   * about .004 on the men a draft is about.
   */
  ownBudget: boolean;
  /** whether a man past his prime is marked down for it */
  byAge: boolean;
  competition?: CompetitionSettings;
}

export const SHARE_DEFAULTS: ShareSettings = {
  weights: [1, 0.55, 0.3],
  ownBudget: true,
  byAge: true,
};

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

/**
 * The seasons behind a projection, keyed by season then player.
 *
 * The plays each offence ran come from the caller because two callers
 * count them differently: one off the curated play file, one off what
 * the walk simulated.
 */
export async function pastShares(
  seasons: number[],
  playsFor: (season: number, team: string) => number,
): Promise<Map<number, Map<string, PastYear>>> {
  const out = new Map<number, Map<string, PastYear>>();

  for (const season of seasons) {
    const tally = new Map<string, PastYear>();

    for (const s of await loadPlayerStats(season)) {
      if (s.week > 18 || !SHARING_POSITIONS.includes(s.position)) {
        continue;
      }

      const own = tally.get(s.playerId) ?? {
        playerId: s.playerId, position: s.position, team: s.teamId,
        games: 0, touches: 0, share: 0,
      };
      own.games++;
      own.touches += s.carries + s.targets;
      own.team = s.teamId;
      tally.set(s.playerId, own);
    }

    for (const own of tally.values()) {
      own.share = own.touches / Math.max(1, playsFor(season, own.team));
    }

    out.set(season, tally);
  }

  return out;
}

/** how many years each man had behind him going into the season */
export async function experienceBefore(
  season: number,
): Promise<Map<string, number>> {
  const years = new Map<string, number>();

  for (const row of await loadWeeklyRosters(season - 1)) {
    if (row.yearsExperience !== undefined) {
      years.set(row.playerId, row.yearsExperience);
    }
  }

  return years;
}

/** what the position groups took, per team and across the league */
function budgetsFrom(
  past: Map<number, Map<string, PastYear>>, season: number,
): { own: Map<string, number>; league: Map<string, number> } {
  const own = new Map<string, number>();
  const pooled = new Map<string, number[]>();
  const looking = [season - 2, season - 1].filter((s) => past.has(s));

  for (const s of looking) {
    const byTeam = new Map<string, Map<string, number>>();

    for (const man of past.get(s)!.values()) {
      const team = byTeam.get(man.team) ?? new Map<string, number>();
      team.set(man.position, (team.get(man.position) ?? 0) + man.share);
      byTeam.set(man.team, team);
    }

    for (const [team, took] of byTeam) {
      for (const position of SHARING_POSITIONS) {
        const key = `${team}|${position}`;
        own.set(
          key, (own.get(key) ?? 0) + (took.get(position) ?? 0) / looking.length,
        );
        pooled.set(position, [
          ...(pooled.get(position) ?? []), took.get(position) ?? 0,
        ]);
      }
    }
  }

  return {
    own,
    league: new Map(
      SHARING_POSITIONS.map((p) => [p, middle(pooled.get(p) ?? [0.2])]),
    ),
  };
}

/**
 * What men taken in each round have gone on to take, so a rookie with
 * nothing behind him can be placed at all.
 */
function rookieStandings(
  past: Map<number, Map<string, PastYear>>, picks: Map<string, DraftPick>,
): (position: string, round: number) => number {
  const seen = new Map<string, number[]>();

  for (const [season, men] of past) {
    for (const man of men.values()) {
      const pick = picks.get(man.playerId);

      if (!pick || pick.season !== season) {
        continue;
      }

      const key = `${man.position}|${Math.min(pick.round, 5)}`;
      seen.set(key, [...(seen.get(key) ?? []), man.share]);
    }
  }

  return (position, round) => {
    for (const step of [0, -1, 1, -2, 2, -3, 3]) {
      const at = Math.min(5, Math.max(1, round + step));
      const found = seen.get(`${position}|${at}`) ?? [];

      if (found.length >= 4) {
        return middle(found);
      }
    }

    return 0.02;
  };
}

/** a back loses work sooner than a receiver does */
function pastPrime(position: string, years: number): number {
  const over = position === "RB" ? 7 : 9;

  return years > over ? Math.pow(0.88, years - over) : 1;
}

export interface ShareRequest {
  /** the season being projected */
  season: number;
  /** who is where going into it */
  roster: RosterMan[];
  /** the seasons behind it, from pastShares */
  past: Map<number, Map<string, PastYear>>;
  picks: Map<string, DraftPick>;
  /** years behind each man, from experienceBefore */
  experience: Map<string, number>;
  settings?: ShareSettings;
}

/**
 * Each man's projected share of his offence's plays.
 *
 * Shares within a position group add up to what that group takes, so
 * a man alone at his position gets all of it and a man behind two
 * better ones gets little however good his last season was.
 */
export function projectShares(request: ShareRequest): Map<string, number> {
  const { season, roster, past, picks, experience } = request;
  const settings = request.settings ?? SHARE_DEFAULTS;
  const budgets = budgetsFrom(past, season);
  const asRookie = rookieStandings(past, picks);

  const standing = (playerId: string, position: string) => {
    let total = 0;
    let weight = 0;
    let anySeason = false;

    for (let i = 0; i < settings.weights.length; i++) {
      const was = past.get(season - 1 - i)?.get(playerId);

      if (!was) {
        continue;
      }

      anySeason = true;
      total += settings.weights[i]! * was.share;
      weight += settings.weights[i]!;
    }

    if (!anySeason) {
      const pick = picks.get(playerId);

      return pick ? asRookie(position, pick.round) : 0;
    }

    const shown = total / weight;

    return settings.byAge
      ? shown * pastPrime(position, experience.get(playerId) ?? 3)
      : shown;
  };

  const byTeam = new Map<string, RosterMan[]>();

  for (const man of roster) {
    byTeam.set(man.team, [...(byTeam.get(man.team) ?? []), man]);
  }

  const said = new Map<string, number>();

  for (const [team, men] of byTeam) {
    for (const position of SHARING_POSITIONS) {
      const group = men.filter((m) => m.position === position);

      if (!group.length) {
        continue;
      }

      const league = budgets.league.get(position) ?? 0.2;
      const total = settings.ownBudget
        ? budgets.own.get(`${team}|${position}`) ?? league
        : league;
      const shares = divideAmong(
        group.map((man) => ({
          playerId: man.playerId,
          standing: standing(man.playerId, man.position),
        })),
        total,
        settings.competition,
      );

      for (const [playerId, share] of shares) {
        said.set(playerId, share);
      }
    }
  }

  return said;
}
