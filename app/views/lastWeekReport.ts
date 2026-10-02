/**
 * Last week's recap, for the league tab to show while none of the games
 * in the week on screen are over.
 *
 * The week is read once per league and week on screen, the first time it
 * is wanted, and kept. A read that fails leaves no recap at all, since a
 * recap that cannot be built is nothing the reader needs to hear about.
 */

import { useEffect, useMemo, useRef, useState } from "preact/hooks";

import { linesFor, settledGames } from "../lib/matchups.ts";
import type { RecapWeek } from "../lib/recapWeek.ts";
import type { Player } from "../lib/scoring.ts";
import { pregameOf, reportFor, type Report } from "../lib/weekReport.ts";

export interface LastWeekOf {
  league: string | undefined;
  /** the week on screen, so a new one reads its own week before */
  season: number;
  week: number;
  players: Player[];
  catchShift: number;
  slots: string[] | null;
  rostered: Set<string>;
}

interface Loaded {
  of: string;
  got: RecapWeek | null;
}

/** the recap of a week read in full, worked out the way the tab's own is */
export function recapOf(
  got: RecapWeek, league: string, of: LastWeekOf,
): Report {
  const lines = linesFor(of.players, got.week, of.catchShift);
  const games = settledGames(got.games, got.rows, got.states, lines);

  return reportFor({
    league,
    week: got.week,
    games,
    rows: got.rows,
    states: got.states,
    lines,
    slots: of.slots,
    pregame: games.length ? pregameOf(games, got.rows, lines) : [],
    ...(got.weeks ? { weeks: got.weeks } : {}),
    rostered: of.rostered,
  });
}

export function useLastWeekReport(
  wanted: boolean,
  read: (() => Promise<RecapWeek>) | undefined,
  of: LastWeekOf,
): Report | null {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const asks = useRef(read);
  const key = `${of.league}/${of.season}/${of.week}`;

  asks.current = read;

  useEffect(() => {
    const asking = asks.current;

    if (!wanted || !asking || loaded?.of === key) {
      return;
    }

    let stale = false;

    asking()
      .then((got) => { if (!stale) { setLoaded({ of: key, got }); } })
      .catch(() => { if (!stale) { setLoaded({ of: key, got: null }); } });

    return () => { stale = true; };
  }, [wanted, key, Boolean(read)]);

  const got = loaded?.of === key ? loaded.got : null;
  const { league, players, catchShift, slots, rostered } = of;

  return useMemo(
    () => got && league ? recapOf(got, league, of) : null,
    [got, league, players, catchShift, slots, rostered],
  );
}
