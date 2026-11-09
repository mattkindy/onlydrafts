/**
 * The season in numbers: how each team has scored, what its record
 * would be playing everybody, how well it has set its lineups, and how
 * often it makes the playoffs when the rest of the season is played out.
 *
 * Every played week is read once from the provider and kept for the
 * session, since a finished week does not change. The weeks still to
 * come are read for their pairings alone.
 */

import { useEffect, useMemo, useState } from "preact/hooks";

import type { Listed } from "../lib/availability.ts";
import {
  linesFor, settledGames, standingFor, type GameState,
} from "../lib/matchups.ts";
import { PROVIDERS, type League, type Matchup } from "../lib/providers.ts";
import type { Player } from "../lib/scoring.ts";
import {
  bestLineupPoints, luckOf, playoffOdds, seasonOf, startingSlots,
  weeklySpread, winShare, type Strength, type TeamSeason,
} from "../lib/seasonStats.ts";
import { catchShiftOf, type SlateRow } from "../lib/slate.ts";
import { pct } from "./Advice.tsx";
import { Skeleton } from "./Reading.tsx";
import { ShareButton } from "./ShareButton.tsx";
import {
  layoutPlayoffs, layoutSeasonTable, sharePlayoffs, shareSeasonTable,
} from "../lib/shareStats.ts";
import { ordinal, recordSays } from "./Standings.tsx";

interface Props {
  league: League;
  /** the board in this league's terms, for each roster's projection */
  players: Player[];
  /** the week coming up, which is where the season left to play starts */
  coming: number;
  /** the week on screen elsewhere, and its games, if it is the coming one */
  thisWeek?: {
    games: Matchup[];
    rows: Map<string, SlateRow>;
    states: Map<string, GameState> | null;
  } | undefined;
  boardPerCatch?: number | undefined;
  listed: Map<string, Listed>;
}

/** weeks read this session, by league and week */
const kept = new Map<string, Matchup[]>();

/**
 * The statuses that keep a player out for weeks rather than days, whose
 * points a roster's projection should not count on.
 */
const GONE_A_WHILE = new Set(["IR", "PUP", "NA", "Sus"]);

/** how often the season is played out */
const SEASONS = 5000;

function useWeeks(league: League, through: number) {
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

/** a number of points, to one place */
const pts = (n: number) => n.toFixed(1);

/** where a team sits among the league on one measure, most first */
function rankOf(teams: TeamSeason[], owner: string, by: (t: TeamSeason) => number) {
  const order = [...teams].sort((a, b) => by(b) - by(a));

  return order.findIndex((t) => t.owner === owner) + 1;
}

function Tile(
  { label, value, note }: { label: string; value: string; note?: string },
) {
  return (
    <div class="tile">
      <i>{label}</i>
      <b>{value}</b>
      {note && <span>{note}</span>}
    </div>
  );
}

/**
 * Your score each week as a bar, the league's median as a dashed line
 * across them, and the result under each. One colour, since there is one
 * series; the result is written rather than coloured. Tapping a bar says
 * its week in full under the chart.
 */
function Weeks(
  { mine, medians, results, opponents }: {
    mine: (number | null)[];
    medians: number[];
    results: ("W" | "L" | "T" | null)[];
    opponents: (string | null)[];
  },
) {
  const [picked, setPicked] = useState<number | null>(null);
  const top = Math.max(1, ...mine.map((m) => m ?? 0), ...medians) * 1.08;
  const h = 120;
  const y = (v: number) => h - (v / top) * h;
  const at = picked ?? mine.length - 1;

  return (
    <div class="weeks">
      <div class="wchart" role="list">
        {mine.map((score, i) => (
          <button
            key={i}
            role="listitem"
            class={"wbar" + (i === at ? " on" : "")}
            aria-label={`week ${i + 1}: ${score === null ? "no game" : pts(score)}` +
              (results[i] ? `, ${results[i]}` : "")}
            onClick={() => setPicked(i)}
          >
            <span class="col">
              {score !== null && (
                <u style={{ height: `${(score / top) * 100}%` }} />
              )}
              <s style={{ bottom: `${((medians[i] ?? 0) / top) * 100}%` }} />
            </span>
            <em>{results[i] ?? "–"}</em>
            <small>{i + 1}</small>
          </button>
        ))}
        <span class="wgrid" aria-hidden="true" style={{ top: `${y(top / 1.08)}px` }} />
      </div>
      {mine[at] !== undefined && (
        <p class="wsay">
          <b>week {at + 1}</b>
          {mine[at] === null
            ? " no game"
            : <>
                {" "}{pts(mine[at]!)}
                {opponents[at] && <> vs {opponents[at]}</>}
                {results[at] && <> · {results[at] === "W" ? "won" : results[at] === "L" ? "lost" : "tied"}</>}
                {" "}· league median {pts(medians[at] ?? 0)}
              </>}
        </p>
      )}
      <p class="hint">Bars are your score, the dashed mark the league's median.</p>
    </div>
  );
}

export function Stats(props: Props) {
  const { league, players, coming } = props;
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
   */
  const strength = useMemo(() => {
    const starting = startingSlots(league.slots);
    const projected = new Map(league.allRosters.map((team) => [
      team.owner,
      bestLineupPoints(
        team.keys
          .filter((p) => !GONE_A_WHILE.has(props.listed.get(p.key)?.status ?? ""))
          .map((p) => ({
            points: byKey.get(p.key)?.ppg ?? 0,
            position: byKey.get(p.key)?.position ?? p.pos,
          })),
        starting,
      ),
    ]));
    const weeksPlayed = season.flatMap((t) => t.weekly.filter((w): w is number => w !== null));
    const actual = weeksPlayed.length
      ? weeksPlayed.reduce((a, b) => a + b, 0) / weeksPlayed.length
      : null;
    const projectedAll = [...projected.values()];
    const meanProjected = projectedAll.reduce((a, b) => a + b, 0) /
      Math.max(1, projectedAll.length);
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

    return new Map<string, Strength>([...projected].map(([owner, mean]) => [
      owner, { mean: mean * scale * coaching(owner), sd },
    ]));
  }, [league, byKey, season, props.listed]);

  /** this week's games with their odds, where the week on screen is this one */
  const thisWeek = useMemo(() => {
    const now = props.thisWeek;

    if (!now?.states || !now.games.length) {
      return undefined;
    }

    const lines = linesFor(players, coming, catchShiftOf(league.pays ?? {}, props.boardPerCatch));
    const settled = settledGames(now.games, now.rows, now.states, lines);

    return settled.map((game) => {
      const { odds, projected } = standingFor(
        game, { rows: now.rows, states: now.states!, lines, remainder: null });

      return {
        a: game.sides[0].owner, b: game.sides[1].owner, odds: odds[0], projected,
      };
    });
  }, [props.thisWeek, players, coming, league.pays, props.boardPerCatch]);

  const run = useMemo(() => {
    if (!weeks || coming > lastRegular) {
      return null;
    }

    const pairsOf = (week: number): [string, string][] =>
      (weeks.get(week) ?? []).map((g) => [g.sides[0].owner, g.sides[1].owner]);
    const toCome = Array.from(
      { length: lastRegular - coming + 1 }, (_, i) => pairsOf(coming + i));
    const owners = new Set([
      ...league.allRosters.map((r) => r.owner), ...season.map((t) => t.owner),
    ]);
    const table = [...owners].map((owner) => {
      const team = season.find((t) => t.owner === owner);

      return { owner, wins: team?.wins ?? 0, ties: team?.ties ?? 0, pf: team?.pf ?? 0 };
    });

    return playoffOdds({
      table,
      weeks: toCome,
      strength,
      playoffTeams: league.playoffTeams ?? (league.size >= 12 ? 6 : 4),
      ...(thisWeek ? { thisWeek } : {}),
      mine: league.team,
      draws: SEASONS,
    });
  }, [weeks, coming, lastRegular, season, strength, league, thisWeek]);

  if (trouble) {
    return <p class="hint">{trouble}</p>;
  }

  if (!weeks) {
    return <Skeleton saying="reading every week of the season" cards={3} />;
  }

  const me = season.find((t) => t.owner === league.team);
  const myOdds = run?.odds.find((o) => o.owner === league.team);
  const playoffTeams = league.playoffTeams ?? (league.size >= 12 ? 6 : 4);
  const placed = [...season].sort((a, b) =>
    (b.wins + b.ties / 2) - (a.wins + a.ties / 2) || b.pf - a.pf);
  const medians = played.map(({ games }) => {
    const all = games.flatMap((g) => g.sides.map((s) => s.points)).sort((a, b) => a - b);
    const mid = Math.floor(all.length / 2);

    return all.length ? (all.length % 2 ? all[mid]! : (all[mid - 1]! + all[mid]!) / 2) : 0;
  });
  const mineOf = played.map(({ games }) => {
    for (const g of games) {
      const at = g.sides.findIndex((s) => s.owner === league.team);

      if (at >= 0) {
        const mine = g.sides[at]!;
        const them = g.sides[1 - at]!;

        return {
          score: mine.points,
          against: them.owner,
          result: mine.points > them.points ? "W" as const
            : mine.points < them.points ? "L" as const : "T" as const,
        };
      }
    }

    return null;
  });

  return (
    <>
      {me && (
        <section class="statcard" aria-label="your season">
          <div class="shead">
            <b>{league.team}</b>
            <span>
              {recordSays(me)} · {ordinal(placed.findIndex((t) => t.owner === me.owner) + 1)}
            </span>
          </div>
          <div class="tiles">
            {myOdds && (
              <Tile
                label="playoff chance"
                value={pct(myOdds.playoffs)}
                {...(run?.ifWin != null && run.ifLose != null
                  ? { note: `${pct(run.ifWin)} if you win this week, ${pct(run.ifLose)} if not` }
                  : {})}
              />
            )}
            <Tile
              label="all-play"
              value={pct(winShare(me.allWins, me.allLosses, me.allTies))}
              note={`${recordSays({ wins: me.allWins, losses: me.allLosses, ties: me.allTies })} against everybody`}
            />
            <Tile
              label="points for"
              value={pts(me.pf)}
              note={`${ordinal(rankOf(season, me.owner, (t) => t.pf))} most`}
            />
            <Tile
              label="points against"
              value={pts(me.pa)}
              note={`${ordinal(rankOf(season, me.owner, (t) => t.pa))} most`}
            />
            <Tile
              label="luck"
              value={(luckOf(me) >= 0 ? "+" : "") + luckOf(me).toFixed(1) + " wins"}
              note="wins over what your scoring earns"
            />
            <Tile
              label="start efficiency"
              value={me.best > 0 ? pct(me.started / me.best) : "–"}
              note={`${pts(me.best - me.started)} pts left on your bench`}
            />
          </div>
        </section>
      )}

      {run && (
        <>
          {/* every table here goes to the league chat as a picture, since
              the playoff race is the one thing the whole league argues over */}
          <div class="sectionhead">
            <h2>playoff chances</h2>
            <ShareButton
              label="share"
              onShare={() => sharePlayoffs(layoutPlayoffs({
                league: league.name,
                week: coming,
                playoffTeams,
                teams: run.odds.map((o) => {
                  const team = season.find((t) => t.owner === o.owner);

                  return {
                    name: o.owner,
                    record: team ? recordSays(team) : "0-0",
                    wins: o.wins,
                    odds: o.playoffs,
                    mine: o.owner === league.team,
                  };
                }),
              }))}
            />
          </div>
          <div class="odds-list">
            {[...run.odds].sort((a, b) => b.playoffs - a.playoffs || b.wins - a.wins)
              .map((o) => {
                const team = season.find((t) => t.owner === o.owner);

                return (
                  <div class={"orow" + (o.owner === league.team ? " on" : "")} key={o.owner}>
                    <span class="onm">{o.owner}</span>
                    <span class="orec">
                      {team ? recordSays(team) : "0-0"}
                      <small>{o.wins.toFixed(1)} proj W</small>
                    </span>
                    <span class="obar" aria-hidden="true">
                      <u style={{ width: `${o.playoffs * 100}%` }} />
                    </span>
                    <b>{pct(o.playoffs)}</b>
                  </div>
                );
              })}
          </div>
          <p class="hint">
            The top {playoffTeams} make it. The rest of the regular season,
            played out {SEASONS.toLocaleString()} times, each team scoring
            around what its roster projects to start, moved halfway toward
            how well it has set its lineups
            {thisWeek ? ", and this week from its lineups" : ""}.
          </p>
        </>
      )}

      {mineOf.some(Boolean) && (
        <>
          <h2>your weeks</h2>
          <Weeks
            mine={mineOf.map((m) => m?.score ?? null)}
            medians={medians}
            results={mineOf.map((m) => m?.result ?? null)}
            opponents={mineOf.map((m) => m?.against ?? null)}
          />
        </>
      )}

      {season.length > 0 && (
        <>
          <div class="sectionhead">
            <h2>every team</h2>
            <ShareButton
              label="share"
              onShare={() => shareSeasonTable(layoutSeasonTable({
                league: league.name,
                week: coming - 1,
                teams: [...season].sort((a, b) =>
                  (b.wins + b.ties / 2) - (a.wins + a.ties / 2) || b.pf - a.pf)
                  .map((t) => ({
                    name: t.owner,
                    record: recordSays(t),
                    pf: t.pf,
                    pa: t.pa,
                    allPlay: winShare(t.allWins, t.allLosses, t.allTies),
                    luck: luckOf(t),
                    efficiency: t.best > 0 ? t.started / t.best : null,
                    mine: t.owner === league.team,
                  })),
              }))}
            />
          </div>
          <div class="scroll">
            <table class="rating standings stats">
              <thead>
                <tr>
                  <th>team</th><th>pf</th><th>pa</th><th>all-play</th>
                  <th>luck</th><th>start eff</th>
                </tr>
              </thead>
              <tbody>
                {[...season].sort((a, b) => b.pf - a.pf).map((t) => (
                  <tr key={t.owner} class={t.owner === league.team ? "on" : ""}>
                    <td>{t.owner}</td>
                    <td>{pts(t.pf)}</td>
                    <td>{pts(t.pa)}</td>
                    <td>{pct(winShare(t.allWins, t.allLosses, t.allTies))}</td>
                    <td>{(luckOf(t) >= 0 ? "+" : "") + luckOf(t).toFixed(1)}</td>
                    <td>{t.best > 0 ? pct(t.started / t.best) : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
