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

import { playChance, SEASON_WEEKS, statusOf, type Listed } from "./availability.ts";
import { PROVIDERS, type League, type Matchup, type RosterPlayer } from "./providers.ts";
import type { Player } from "./scoring.ts";
import { forTheWeeksLeft, statusesOn } from "./waiversSeason.ts";
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
  const level = leagueLevel(input.season, base);

  return new Map<string, Strength>([...projected].map(([owner, mean]) => [
    owner, { mean: mean * level.scale * level.coaching(owner), sd: level.sd },
  ]));
}

/**
 * What turns a roster's line into a team's week: the one scale that
 * takes the league's projected lineups to what it really scores, the
 * spread of a week, and each manager's own start efficiency.
 */
function leagueLevel(season: TeamSeason[], base: number[]) {
  const weeksPlayed = season.flatMap((t) => t.weekly.filter((w): w is number => w !== null));
  const actual = weeksPlayed.length
    ? weeksPlayed.reduce((a, b) => a + b, 0) / weeksPlayed.length
    : null;
  const meanProjected = base.reduce((a, b) => a + b, 0) / Math.max(1, base.length);
  const scale = actual && meanProjected ? actual / meanProjected : 1;
  const sd = weeklySpread(season, actual ?? meanProjected);
  const started = season.reduce((sum, t) => sum + t.started, 0);
  const best = season.reduce((sum, t) => sum + t.best, 0);
  const leagueEff = best > 0 ? started / best : 1;
  const coaching = (owner: string) => {
    const team = season.find((t) => t.owner === owner);

    return team && team.best > 0
      ? 1 + 0.5 * (team.started / team.best / leagueEff - 1)
      : 1;
  };

  return { scale, sd, coaching };
}

/**
 * His chance of playing in a week, `at` weeks after the coming one. The
 * coming week is the injury report's: out is out and a questionable man
 * plays about two times in three. Past it, his weeks left say, which
 * carry his bye, a return from reserve and the board's games; a player
 * with none is counted on unless a list keeps him out for weeks.
 */
export function chanceIn(p: Player | undefined, at: number, status: string | undefined): number {
  if (!p) {
    return 0;
  }

  const plays = p.weeksLeft?.plays[at];

  if (at === 0) {
    return plays === 0 ? 0 : playChance(status);
  }

  return plays ?? (GONE_A_WHILE.has(status ?? "") ? 0 : 1);
}

/**
 * Each team's strength week by week from the coming one, `weeks` of them:
 * the best lineup its roster can put out that week, each player at his
 * points a game times his chance of playing it. A bye costs the week it
 * falls in, and a starter back from reserve counts from the weeks he is
 * expected back, the playoffs included, which a single strength for the
 * whole run cannot say. The league's scale is taken over all the weeks
 * together, from the rosters before any trade, so a week of byes reads
 * lower than one without and a what-if moves only the two teams in it.
 *
 * A slot the roster cannot fill that week, its only quarterback on a bye
 * or a trade that leaves it a back short, takes a free agent rather than
 * nothing, since that is what any manager does. The wire is priced at
 * the third best free agent at each position that week, not the best:
 * the best is often claimed before you, and a rostered player the board
 * failed to match to his roster would otherwise be lent to every team.
 * The third is a judgement, not fitted.
 */
export const WIRE_RANK = 3;

/** how a team's week is built, said the same wherever odds are shown */
export const HOW_ODDS_WORK =
  "Each team plays the best lineup its whole roster allows every week, not the one " +
  "its manager sets, each player at his points a game times his chance of playing " +
  "that week: his bye, the injury report, a return from reserve. A slot nobody on " +
  "the roster can fill takes the third best free agent. Scaled to what the league " +
  "really scores, and each manager's start efficiency counts for half.";

export function weeklyStrengths(input: {
  rosters: { owner: string; keys: RosterPlayer[] }[];
  slots: string[] | null;
  byKey: Map<string, Player>;
  listed: Map<string, Listed>;
  season: TeamSeason[];
  weeks: number;
  scaleFrom?: { owner: string; keys: RosterPlayer[] }[];
}): Map<string, Strength>[] {
  const starting = startingSlots(input.slots);
  const statusOfKey = (key: string) => {
    const his = input.listed.get(key);

    return his ? statusOf(his) : undefined;
  };
  const wire = wireByWeek(input.rosters, input.byKey, input.weeks, statusOfKey);
  const lineupsOf = (keys: RosterPlayer[]) => Array.from({ length: input.weeks }, (_, at) =>
    bestLineupPoints(
      [
        ...keys.map((p) => {
          const his = input.byKey.get(p.key);

          return {
            points: (his?.ppg ?? 0) * chanceIn(his, at, statusOfKey(p.key)),
            position: his?.position ?? p.pos,
          };
        }),
        ...wire[at]!,
      ],
      starting,
    ));
  const projected = input.rosters.map((team) => [team.owner, lineupsOf(team.keys)] as const);
  const base = input.scaleFrom
    ? input.scaleFrom.flatMap((team) => lineupsOf(team.keys))
    : projected.flatMap(([, weeks]) => weeks);
  const level = leagueLevel(input.season, base);

  return Array.from({ length: input.weeks }, (_, at) => new Map<string, Strength>(
    projected.map(([owner, weeks]) => [
      owner, { mean: weeks[at]! * level.scale * level.coaching(owner), sd: level.sd },
    ])));
}

/**
 * The free agent a team could pick up at each position, each week: the
 * one at `WIRE_RANK` among the players nobody has, at his points a game
 * times his chance of playing that week. One a position a week, since a
 * roster short two at once is rare and a second pickup is a worse one.
 */
export function wireByWeek(
  rosters: { keys: RosterPlayer[] }[],
  byKey: Map<string, Player>,
  weeks: number,
  statusOfKey: (key: string) => string | undefined,
): { points: number; position: string }[][] {
  const rostered = new Set(rosters.flatMap((t) => t.keys.map((p) => p.key)));
  const free = [...byKey.values()].filter((p) => !rostered.has(p.key) && p.position);

  return Array.from({ length: weeks }, (_, at) => {
    const byPosition = new Map<string, number[]>();

    for (const p of free) {
      const points = (p.ppg ?? 0) * chanceIn(p, at, statusOfKey(p.key));

      if (points > 0) {
        const there = byPosition.get(p.position) ?? [];

        there.push(points);
        byPosition.set(p.position, there);
      }
    }

    return [...byPosition].map(([position, points]) => {
      const ranked = points.sort((a, b) => b - a);

      return { points: ranked[Math.min(ranked.length, WIRE_RANK) - 1]!, position };
    });
  });
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
  // each player with his chance of playing each week left, report and all
  const byKey = useMemo(() => new Map(
    forTheWeeksLeft(players, coming, statusesOn(players, listed)).map((p) => [p.key, p])),
  [players, coming, listed]);
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

  // the weeks left and the longest bracket after them, inside the season
  const ahead = Math.max(0, Math.min(SEASON_WEEKS, lastRegular + MOST_ROUNDS) - coming + 1);
  const weekly = useMemo(() => weeklyStrengths({
    rosters: league.allRosters, slots: league.slots, byKey, listed, season, weeks: ahead,
  }), [league, byKey, season, listed, ahead]);

  const setup = useMemo(() => seasonSetup({
    weeks, coming, lastRegular, season, owners: league.allRosters.map((r) => r.owner),
  }), [weeks, coming, lastRegular, season, league]);

  return { weeks, trouble, byKey, played, season, strength, weekly, setup, lastRegular };
}

/** a bracket of sixteen, the most a league runs */
const MOST_ROUNDS = 4;

/**
 * Weekly strengths from the coming week split where the regular season
 * ends: the weeks still to play, and the playoff rounds after them.
 */
export function splitAtPlayoffs(
  weekly: Map<string, Strength>[], coming: number, lastRegular: number, rounds: number,
): { byWeek: Map<string, Strength>[]; bracket: Map<string, Strength>[] } {
  const regular = Math.max(0, lastRegular - coming + 1);

  return { byWeek: weekly.slice(0, regular), bracket: weekly.slice(regular, regular + rounds) };
}
