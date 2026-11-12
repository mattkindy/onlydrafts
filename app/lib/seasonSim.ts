/**
 * What playing out the rest of a season needs, read once and shared: every
 * week's games, the season so far, each team's weekly scoring from its
 * roster, and the table and pairings still to come.
 *
 * The stats tab plays the season out as it stands. A trade plays it out
 * again with two rosters changed, which is the same machinery with
 * different rosters handed to `teamStrengths`.
 */

import { useEffect, useMemo, useState } from "preact/hooks";

import type { Listed } from "./availability.ts";
import { PROVIDERS, type League, type Matchup, type RosterPlayer } from "./providers.ts";
import type { Player } from "./scoring.ts";
import {
  bestLineupPoints, seasonOf, startingSlots, weeklySpread,
  type SeedRow, type Strength, type TeamSeason,
} from "./seasonStats.ts";

/** weeks read this session, by league and week */
const kept = new Map<string, Matchup[]>();

/**
 * The statuses that keep a player out for weeks rather than days, whose
 * points a roster's projection should not count on.
 */
export const GONE_A_WHILE = new Set(["IR", "PUP", "NA", "Sus"]);

export function useWeeks(league: League, through: number) {
  const [weeks, setWeeks] = useState<Map<number, Matchup[]> | null>(null);
  const [trouble, setTrouble] = useState("");

  useEffect(() => {
    const asks = PROVIDERS[league.provider]?.matchupsFor;

    if (!asks) {
      setTrouble(`${league.provider} does not share its weeks.`);

      return;
    }

    let stale = false;
    // Sleeper's own points settle a finished week, so its weekly stats,
    // a large file a week, are not read for weeks already played
    const quiet = league.provider === "sleeper" ? { ...league, pays: {} } : league;
    const keyOf = (week: number) =>
      [league.provider, league.leagueId, league.userId, week].join("/");
    const wanted = Array.from({ length: through }, (_, i) => i + 1);

    Promise.all(wanted.map(async (week) => {
      const have = kept.get(keyOf(week));

      if (have) {
        return [week, have] as const;
      }

      const got = await asks(quiet, week).catch(() => [] as Matchup[]);

      if (got.length) {
        kept.set(keyOf(week), got);
      }

      return [week, got] as const;
    }))
      .then((all) => { if (!stale) { setWeeks(new Map(all)); } })
      .catch((e: Error) => { if (!stale) { setTrouble(e.message); } });

    return () => { stale = true; };
  }, [league.provider, league.leagueId, league.userId, through]);

  return { weeks, trouble };
}

/**
 * Each team's weekly scoring for the simulation: the best lineup its
 * roster can put out today, each player at his points a game in this
 * league's scoring, leaving out anybody on a list that keeps him out
 * for weeks. Points a game run high, since nobody plays every week, so
 * every team is scaled by the same amount to the league's actual
 * scoring.
 *
 * That alone assumes every manager sets the league's average lineup.
 * Each team is moved toward its own start efficiency instead, halfway,
 * since a few weeks of lineup calls are partly luck: a team that has
 * started 95% of its best where the league starts 90% scores about 3%
 * over its roster's line.
 *
 * `scaleFrom` keeps a trade's what-if on the same footing as the season
 * as it stands: the league's scale is worked out from the rosters before
 * the trade, so swapping two players moves the two teams and nobody else.
 */
export function teamStrengths(input: {
  rosters: { owner: string; keys: RosterPlayer[] }[];
  slots: string[] | null;
  byKey: Map<string, Player>;
  listed: Map<string, Listed>;
  season: TeamSeason[];
  scaleFrom?: { owner: string; keys: RosterPlayer[] }[];
}): Map<string, Strength> {
  const starting = startingSlots(input.slots);
  const lineupOf = (keys: RosterPlayer[]) => bestLineupPoints(
    keys
      .filter((p) => !GONE_A_WHILE.has(input.listed.get(p.key)?.status ?? ""))
      .map((p) => ({
        points: input.byKey.get(p.key)?.ppg ?? 0,
        position: input.byKey.get(p.key)?.position ?? p.pos,
      })),
    starting,
  );
  const projected = new Map(input.rosters.map((team) => [team.owner, lineupOf(team.keys)]));
  const base = input.scaleFrom
    ? input.scaleFrom.map((team) => lineupOf(team.keys))
    : [...projected.values()];
  const weeksPlayed = input.season.flatMap((t) => t.weekly.filter((w): w is number => w !== null));
  const actual = weeksPlayed.length
    ? weeksPlayed.reduce((a, b) => a + b, 0) / weeksPlayed.length
    : null;
  const meanProjected = base.reduce((a, b) => a + b, 0) / Math.max(1, base.length);
  const scale = actual && meanProjected ? actual / meanProjected : 1;
  const sd = weeklySpread(input.season, actual ?? meanProjected);
  const started = input.season.reduce((sum, t) => sum + t.started, 0);
  const best = input.season.reduce((sum, t) => sum + t.best, 0);
  const leagueEff = best > 0 ? started / best : 1;
  const coaching = (owner: string) => {
    const team = input.season.find((t) => t.owner === owner);

    return team && team.best > 0
      ? 1 + 0.5 * (team.started / team.best / leagueEff - 1)
      : 1;
  };

  return new Map<string, Strength>([...projected].map(([owner, mean]) => [
    owner, { mean: mean * scale * coaching(owner), sd },
  ]));
}

/** the pairings of every week left, this one first, and the table now */
export function seasonSetup(input: {
  weeks: Map<number, Matchup[]> | null;
  coming: number;
  lastRegular: number;
  season: TeamSeason[];
  owners: string[];
}): { toCome: [string, string][][]; table: SeedRow[] } | null {
  const { weeks, coming, lastRegular, season } = input;

  if (!weeks || coming > lastRegular) {
    return null;
  }

  const pairsOf = (week: number): [string, string][] =>
    (weeks.get(week) ?? []).map((g) => [g.sides[0].owner, g.sides[1].owner]);
  const toCome = Array.from(
    { length: lastRegular - coming + 1 }, (_, i) => pairsOf(coming + i));
  const owners = new Set([...input.owners, ...season.map((t) => t.owner)]);
  const table = [...owners].map((owner) => {
    const team = season.find((t) => t.owner === owner);

    return {
      owner,
      wins: team?.wins ?? 0,
      ties: team?.ties ?? 0,
      pf: team?.pf ?? 0,
      pa: team?.pa ?? 0,
      allWins: team?.allWins ?? 0,
      allLosses: team?.allLosses ?? 0,
      allTies: team?.allTies ?? 0,
      medianWins: team?.medianWins ?? 0,
      versus: team?.versus ?? {},
    };
  });

  return { toCome, table };
}

/**
 * The season read for a league: its weeks, the season so far, each team's
 * strength as its roster stands, and what is left to play.
 */
export function useSeasonSim(input: {
  league: League;
  players: Player[];
  coming: number;
  listed: Map<string, Listed>;
}) {
  const { league, players, coming, listed } = input;
  const lastRegular = league.lastRegularWeek ?? 14;
  const through = Math.max(coming, lastRegular);
  const { weeks, trouble } = useWeeks(league, through);
  const byKey = useMemo(() => new Map(players.map((p) => [p.key, p])), [players]);
  const positionOf = useMemo(() => {
    const fromRosters = new Map(
      [league.myRoster, ...league.allRosters.map((r) => r.keys)].flat()
        .map((p) => [p.key, p.pos] as const));

    return (key: string) => byKey.get(key)?.position ?? fromRosters.get(key);
  }, [byKey, league]);

  const played = useMemo(() => {
    if (!weeks) {
      return [];
    }

    return Array.from({ length: coming - 1 }, (_, i) => i + 1)
      .map((week) => ({ week, games: weeks.get(week) ?? [] }));
  }, [weeks, coming]);

  const season = useMemo(
    () => seasonOf(played, league.slots, positionOf),
    [played, league.slots, positionOf],
  );

  const strength = useMemo(() => teamStrengths({
    rosters: league.allRosters, slots: league.slots, byKey, listed, season,
  }), [league, byKey, season, listed]);

  const setup = useMemo(() => seasonSetup({
    weeks, coming, lastRegular, season, owners: league.allRosters.map((r) => r.owner),
  }), [weeks, coming, lastRegular, season, league]);

  return { weeks, trouble, byKey, played, season, strength, setup, lastRegular };
}
