/**
 * Where every game in a week has got to, read once a view asks for it.
 *
 * A page that prices a lineup needs to know which games have kicked off
 * before it can say anything, so the read is a hook rather than something
 * each view does for itself. Nothing is asked for until both the season and
 * the week are known, and a read that fails leaves the states empty with a
 * line a page can show.
 */

import { useEffect, useState } from "preact/hooks";

import { gameStates, type GameState } from "../lib/matchups.ts";

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
