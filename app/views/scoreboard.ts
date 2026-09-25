/**
 * Where every game in a week has got to, kept up to date until every game
 * is over.
 *
 * Nothing is asked for until both the season and the week are known, and a
 * read that fails leaves the states empty with a line a page can show. The
 * scoreboard is read every minute while a game is on, and before the first
 * kickoff it waits for that kickoff. It reads again whenever the tab comes
 * back into view.
 *
 * The page polls once, at the top, and hands the reading down. Its count
 * of reads is the clock the league's points are read on as well, so a
 * card's points and its game clock come from the same minute.
 */

import { useEffect, useMemo, useState } from "preact/hooks";

import {
  gameStates, type GameState, type LiveSituation,
} from "../lib/matchups.ts";
import type { League } from "../lib/providers.ts";
import {
  gamesToPlay, REMAINDER_DRAWS, remainderInWorker, simTablesFor,
} from "../lib/remainderDraws.ts";
import type { Pays } from "../lib/scoring.ts";

type Provider = League["provider"];

/** how often the scoreboard is read again while a game is on */
const EVERY = 60_000;

/** the longest wait before the first kickoff, in case the schedule moves */
const LONGEST_WAIT = 30 * 60_000;

/**
 * How long to wait before reading the scoreboard again, or null once
 * every game is over. A game past its kickoff that ESPN still has as not
 * started is read every minute until it starts.
 */
export function nextReadIn(
  states: Map<string, GameState> | null, nextKickoff: number | null, now: number,
): number | null {
  if (!states) {
    return EVERY;
  }

  const where = [...states.values()].map((s) => s.where);

  if (where.includes("in")) {
    return EVERY;
  }

  if (!where.includes("pre")) {
    return null;
  }

  if (nextKickoff === null) {
    return EVERY;
  }

  return Math.min(LONGEST_WAIT, Math.max(EVERY, nextKickoff - now));
}

interface Reading {
  /** the season and week this read was for */
  of: string;
  states: Map<string, GameState>;
  situations: Map<string, LiveSituation>;
  nextKickoff: number | null;
  read: Date;
}

interface PolledWeek {
  states: Map<string, GameState> | null;
  situations: Map<string, LiveSituation> | null;
  read: Date | null;
  trouble: string;
}

export interface WeekPoll extends PolledWeek {
  /** the week the poll is for, so a tab can tell the reading is its own */
  season: number | undefined;
  week: number | undefined;
  /**
   * How many reads have been asked for. Anything that has to move with the
   * scoreboard reads again when this changes, on the same tick.
   */
  tick: number;
}

/** what reads the scoreboard, which a test can stand in for */
export type ReadGames = typeof gameStates;

/**
 * Reads the week's scoreboard, and again on the rules `nextReadIn` sets,
 * until every game is over.
 */
export function useWeekPoll(
  season: number | undefined, week: number | undefined,
  provider: Provider = "espn", readGames: ReadGames = gameStates,
): WeekPoll {
  const [reading, setReading] = useState<Reading | null>(null);
  const [trouble, setTrouble] = useState("");
  /** bumped to ask for another read */
  const [asks, setAsks] = useState(0);
  /** bumped when a read comes back, either way, which arms the next one */
  const [answers, setAnswers] = useState(0);
  const of = `${provider}/${season}/${week}`;

  useEffect(() => {
    if (season === undefined || week === undefined) {
      return;
    }

    let stale = false;

    readGames(season, week, provider)
      .then((got) => {
        if (!stale) {
          setReading({ of, ...got, read: new Date() });
          setTrouble("");
        }
      })
      .catch((e: Error) => {
        if (!stale) {
          setTrouble("could not read the scoreboard: " + e.message);
        }
      })
      .finally(() => {
        if (!stale) {
          setAnswers((n) => n + 1);
        }
      });

    return () => { stale = true; };
  }, [asks, season, week, provider]);

  // a read for last week must not stand in for this one while it loads
  const current = reading?.of === of ? reading : null;

  useEffect(() => {
    if (answers === 0) {
      return;
    }

    const wait = nextReadIn(
      current?.states ?? null, current?.nextKickoff ?? null, Date.now());

    if (wait === null) {
      return;
    }

    const timer = setTimeout(() => setAsks((n) => n + 1), wait);

    return () => clearTimeout(timer);
  }, [answers]);

  // a tab left in the background has its timers slowed or stopped
  useEffect(() => {
    const back = () => {
      if (document.visibilityState === "visible") {
        setAsks((n) => n + 1);
      }
    };

    document.addEventListener("visibilitychange", back);

    return () => document.removeEventListener("visibilitychange", back);
  }, []);

  return useMemo(() => ({
    season,
    week,
    tick: asks,
    states: current?.states ?? null,
    situations: current?.situations ?? null,
    read: current?.read ?? null,
    trouble,
  }), [season, week, asks, current, trouble]);
}

const NOT_READ: PolledWeek = {
  states: null, situations: null, read: null, trouble: "",
};

/**
 * The page's poll where the page hands one down, and a poll of the tab's
 * own where it does not. A tab asking about another week gets no reading.
 */
function useWeekRead(
  season: number | undefined, week: number | undefined,
  provider: Provider | undefined, shared: WeekPoll | null | undefined,
): PolledWeek {
  const own = useWeekPoll(
    shared ? undefined : season, shared ? undefined : week, provider);

  if (!shared) {
    return own;
  }

  return shared.season === season && shared.week === week ? shared : NOT_READ;
}

export function useScoreboard(
  season: number | undefined, week: number | undefined,
  shared?: WeekPoll | null,
): { states: Map<string, GameState> | null; trouble: string } {
  const { states, trouble } = useWeekRead(season, week, undefined, shared);

  return { states, trouble };
}

export interface LiveWeek {
  states: Map<string, GameState> | null;
  /** what the engine says a player in a live game still has to come */
  remainder: Map<string, number[]> | null;
  /** when the scoreboard was last read, for the line that says so */
  read: Date | null;
  live: boolean;
  trouble: string;
}

/**
 * The same read with the rest of each live game played out.
 *
 * From half time on, playing the rest of a game out beats pulling a
 * player's week line toward what he has done, so those games go to the
 * engine and everything earlier stays on the clock scaling.
 */
export function useLiveWeek(
  season: number | undefined, week: number | undefined, pays: Pays,
  provider?: Provider, shared?: WeekPoll | null,
): LiveWeek {
  const { states, situations, read, trouble } =
    useWeekRead(season, week, provider, shared);
  const [remainder, setRemainder] =
    useState<Map<string, number[]> | null>(null);

  const live = states
    ? [...states.values()].some((s) => s.where === "in")
    : false;

  useEffect(() => {
    if (!situations || !gamesToPlay(situations).length || season === undefined) {
      setRemainder(null);

      return;
    }

    let stale = false;

    simTablesFor(season)
      .then((tables) => tables
        ? remainderInWorker(tables, situations, pays, REMAINDER_DRAWS, week)
        : new Map<string, number[]>())
      .then((played) => {
        if (!stale) {
          setRemainder(played.size ? played : null);
        }
      })
      .catch(() => undefined);

    return () => { stale = true; };
  }, [situations, season, week, pays]);

  return { states, remainder, read, live, trouble };
}
