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
  bestLineupPoints, luckOf, pairKey, playoffOdds, seasonOf, startingSlots,
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

/** how many weeks ahead the path runs, and how often each step is played out */
const PATH_WEEKS = 5;
const PATH_SEASONS = 1500;

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

/**
 * Your playoff chance a week at a time if you win every game from here,
 * and if you lose every one: two lines from where you stand now, told
 * apart by their labels and by one being dashed rather than by colour.
 * Tapping a week says both figures for it under the chart.
 */
function PathChart(
  { win, lose, coming }: { win: number[]; lose: number[]; coming: number },
) {
  const [at, setAt] = useState(win.length - 1);
  const W = 340, H = 168, L = 36, R = 74, T = 12, B = 26;
  const x = (i: number) => L + (i * (W - L - R)) / Math.max(1, win.length - 1);
  const y = (p: number) => T + (1 - p) * (H - T - B);
  const line = (vals: number[]) =>
    vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const last = win.length - 1;
  // the two end labels keep 14 units apart, so they never sit on each other
  const winY = y(win[last]!);
  const loseY = Math.max(y(lose[last]!), winY + 14);
  const weekOf = (i: number) => (i === 0 ? "now" : `wk ${coming + i - 1}`);

  return (
    <div class="path">
      <svg viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`playoff chance if you win out: ${pct(win[last]!)}; if you lose out: ${pct(lose[last]!)}`}>
        {[0, 0.5, 1].map((g) => (
          <g key={g}>
            <line class="pgrid" x1={L} x2={W - R} y1={y(g)} y2={y(g)} />
            <text class="paxis" x={L - 6} y={y(g) + 4} text-anchor="end">{g * 100}%</text>
          </g>
        ))}
        <line class="pnow" x1={x(at)} x2={x(at)} y1={T} y2={H - B} />
        <path class="pline lose" d={line(lose)} />
        <path class="pline win" d={line(win)} />
        {win.map((v, i) => <circle key={"w" + i} class="pdot win" cx={x(i)} cy={y(v)} r={4} />)}
        {lose.map((v, i) => <circle key={"l" + i} class="pdot lose" cx={x(i)} cy={y(v)} r={4} />)}
        <text class="plabel" x={x(last) + 8} y={winY + 4}>win out</text>
        <text class="plabel lose" x={x(last) + 8} y={loseY + 4}>lose out</text>
        {win.map((_, i) => (
          <text key={"x" + i} class="paxis" x={x(i)} y={H - 6} text-anchor="middle">
            {weekOf(i)}
          </text>
        ))}
        {/* each week's whole column takes the tap, not just its dots */}
        {win.map((_, i) => (
          <rect
            key={"t" + i} class="ptap" x={x(i) - 18} y={0} width={36} height={H}
            onClick={() => setAt(i)}
          />
        ))}
      </svg>
      <p class="wsay">
        <b>{at === 0 ? "now" : `after week ${coming + at - 1}`}</b>
        {at === 0
          ? ` ${pct(win[0]!)}`
          : <> win them all <b>{pct(win[at]!)}</b> · lose them all <b>{pct(lose[at]!)}</b></>}
      </p>
    </div>
  );
}

/**
 * The games still to come, a week at a time, where tapping a side says
 * it wins. Tapping it again takes the pick back. Every chance on the tab
 * is played out again with the picks in place.
 */
function Picker(
  { toCome, coming, mine, forced, onPick }: {
    toCome: [string, string][][];
    coming: number;
    mine: string;
    forced: Map<string, string>;
    onPick: (week: number, a: string, b: string, winner: string) => void;
  },
) {
  const [w, setW] = useState(0);
  const pairs = toCome[w] ?? [];
  const picksIn = (week: number) =>
    (toCome[week] ?? []).filter(([a, b]) => forced.has(pairKey(week, a, b))).length;

  return (
    <div class="picker">
      <div class="chips" role="tablist">
        {toCome.map((_, i) => (
          <button
            key={i} role="tab" aria-selected={i === w}
            class={i === w ? "on" : ""} onClick={() => setW(i)}
          >
            wk {coming + i}{picksIn(i) ? ` · ${picksIn(i)}` : ""}
          </button>
        ))}
      </div>
      <ul class="picks">
        {pairs.map(([a, b]) => {
          const key = pairKey(w, a, b);
          const won = forced.get(key);
          const side = (who: string) => (
            <button
              class={"side" + (won === who ? " on" : "") + (won && won !== who ? " off" : "") +
                (who === mine ? " mine" : "")}
              aria-pressed={won === who}
              onClick={() => onPick(w, a, b, who)}
            >
              {who}
            </button>
          );

          return (
            <li key={key} class={a === mine || b === mine ? "yours" : ""}>
              {side(a)}
              <span class="v">v</span>
              {side(b)}
            </li>
          );
        })}
      </ul>
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

  /** results somebody has picked, and how you think your team will score */
  const [forced, setForced] = useState<Map<string, string>>(() => new Map());
  const [nudge, setNudge] = useState(0);

  /** the pairings of every week left, this one first, and the table now */
  const setup = useMemo(() => {
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

    return { toCome, table };
  }, [weeks, coming, lastRegular, season, league]);

  /** your team scoring what you think it will, everybody else as projected */
  const adjusted = useMemo(() => {
    if (!nudge) {
      return strength;
    }

    const out = new Map(strength);
    const mine = out.get(league.team);

    if (mine) {
      out.set(league.team, { ...mine, mean: mine.mean * (1 + nudge) });
    }

    return out;
  }, [strength, nudge, league.team]);

  const playOut = (picks: Map<string, string>, draws: number) => setup
    ? playoffOdds({
      table: setup.table,
      weeks: setup.toCome,
      strength: adjusted,
      playoffTeams: league.playoffTeams ?? (league.size >= 12 ? 6 : 4),
      ...(thisWeek ? { thisWeek } : {}),
      mine: league.team,
      draws,
      forced: picks,
    })
    : null;

  const run = useMemo(
    () => playOut(forced, SEASONS),
    [setup, adjusted, league, thisWeek, forced],
  );

  /**
   * Your playoff chance if you win each of your next games, and if you
   * lose each, a week at a time: the two ways the season can go from
   * here, on top of whatever has been picked. A game you have picked
   * keeps your pick.
   */
  const [path, setPath] = useState<{ win: number[]; lose: number[] } | null>(null);

  // worked out just after the tap that changed it, so a pick answers at
  // once and the two lines follow a moment later
  useEffect(() => {
    const soon = setTimeout(() => setPath(pathNow()), 30);

    return () => clearTimeout(soon);
  }, [setup, run, forced, adjusted, league.team]);

  function pathNow() {
    if (!setup || !run) {
      return null;
    }

    const now = run.odds.find((o) => o.owner === league.team)?.playoffs ?? 0;
    const ahead = Math.min(setup.toCome.length, PATH_WEEKS);
    const mineIn = setup.toCome.map((pairs) =>
      pairs.find((pair) => pair.includes(league.team)) ?? null);
    const along = (winning: boolean) => {
      const out = [now];
      const picks = new Map(forced);

      for (let w = 0; w < ahead; w++) {
        const pair = mineIn[w];

        if (pair) {
          const key = pairKey(w, pair[0], pair[1]);
          const them = pair[0] === league.team ? pair[1] : pair[0];

          if (!picks.has(key)) {
            picks.set(key, winning ? league.team : them);
          }
        }

        out.push(playOut(picks, PATH_SEASONS)?.odds
          .find((o) => o.owner === league.team)?.playoffs ?? 0);
      }

      return out;
    };

    return { win: along(true), lose: along(false) };
  }

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
          {(forced.size > 0 || nudge !== 0) && (
            <p class="hint scenario">With your picks under what if.</p>
          )}
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

          {setup && path && (
            <>
              <div class="sectionhead">
                <h2>what if</h2>
                {(forced.size > 0 || nudge !== 0) && (
                  <button
                    class="textbtn"
                    onClick={() => { setForced(new Map()); setNudge(0); }}
                  >
                    reset{forced.size ? ` ${forced.size} pick${forced.size === 1 ? "" : "s"}` : ""}
                  </button>
                )}
              </div>
              <PathChart win={path.win} lose={path.lose} coming={coming} />
              <label class="nudge">
                <span>
                  your scoring against its projection{" "}
                  <b>{nudge > 0 ? "+" : ""}{Math.round(nudge * 100)}%</b>
                </span>
                <input
                  type="range" min={-20} max={20} step={5}
                  value={Math.round(nudge * 100)}
                  onInput={(e) => setNudge(Number(e.currentTarget.value) / 100)}
                />
              </label>
              <Picker
                toCome={setup.toCome}
                coming={coming}
                mine={league.team}
                forced={forced}
                onPick={(w, a, b, winner) => setForced((was) => {
                  const next = new Map(was);
                  const key = pairKey(w, a, b);

                  if (next.get(key) === winner) {
                    next.delete(key);
                  } else {
                    next.set(key, winner);
                  }

                  return next;
                })}
              />
              <p class="hint">
                Tap a team to have it win that game. The chances above, and
                the two lines, play the season out again with your picks.
              </p>
            </>
          )}
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
