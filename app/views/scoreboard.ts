/**
 * Where every game in a week has got to, read once a view asks for it.
 *
 * A page that prices a lineup needs to know which games have kicked off
 * before it can say anything, so the read is a hook rather than something
 * each view does for itself. Nothing is asked for until both the season and
 * the week are known, and a read that fails leaves the states empty with a
 * line a page can show.
 *
 * Two tabs price the same week: your own matchup and the rest of the
 * league. Only one of them is ever on screen, so each reads the
 * scoreboard through the same hook rather than sharing one read.
 */

import { useEffect, useState } from "preact/hooks";

import { gameStates, type GameState, type LiveSituation } from "../lib/matchups.ts";
import {
  gamesToPlay, REMAINDER_DRAWS, remainderInWorker, simTablesFor,
} from "../lib/remainderDraws.ts";
import type { Pays } from "../lib/scoring.ts";

/** how often the scoreboard is read again while a game is on */
const EVERY = 60_000;

export function useScoreboard(
  season: number | undefined, week: number | undefined,
): { states: Map<string, GameState> | null; trouble: string } {
  const [states, setStates] = useState<Map<string, GameState> | null>(null);
  const [trouble, setTrouble] = useState("");

  useEffect(() => {
    if (season === undefined || week === undefined) {
      return;
    }

    let stale = false;

    gameStates(season, week)
      .then((got) => { if (!stale) { setStates(got.states); setTrouble(""); } })
      .catch((e: Error) => {
        if (!stale) {
          setTrouble("could not read the scoreboard: " + e.message);
        }
      });

    return () => { stale = true; };
  }, [season, week]);

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
 * The same read, kept up to date while games are on, with the rest of
 * each live game played out.
 *
 * From half time on, playing the rest of a game out beats pulling a
 * player's week line toward what he has done, so those games go to the
 * engine and everything earlier stays on the clock scaling.
 */
export function useLiveWeek(
  season: number | undefined, week: number | undefined, pays: Pays,
): LiveWeek {
  const [states, setStates] = useState<Map<string, GameState> | null>(null);
  const [situations, setSituations] =
    useState<Map<string, LiveSituation> | null>(null);
  const [remainder, setRemainder] =
    useState<Map<string, number[]> | null>(null);
  const [read, setRead] = useState<Date | null>(null);
  const [trouble, setTrouble] = useState("");
  /**
   * Bumped on every read, which is what asks for the next one. Reading
   * inside a timer that depends on the states themselves would rebuild
   * the timer every minute and drift.
   */
  const [reads, setReads] = useState(0);

  useEffect(() => {
    if (season === undefined || week === undefined) {
      return;
    }

    let stale = false;

    gameStates(season, week)
      .then((got) => {
        if (!stale) {
          setStates(got.states);
          setSituations(got.situations);
          setRead(new Date());
          setTrouble("");
        }
      })
      .catch((e: Error) => {
        if (!stale) {
          setTrouble("could not read the scoreboard: " + e.message);
        }
      });

    return () => { stale = true; };
  }, [reads, season, week]);

  const live = states
    ? [...states.values()].some((s) => s.where === "in")
    : false;

  useEffect(() => {
    if (!live) {
      return;
    }

    const timer = setTimeout(() => setReads((n) => n + 1), EVERY);

    return () => clearTimeout(timer);
  }, [live, reads]);

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
