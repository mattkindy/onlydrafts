/**
 * This week in one league, on its card in the list: who you play, and
 * how often you win.
 *
 * Somebody in three leagues used to open each one in turn to learn the
 * one number they wanted from it. The list now says it for all of them.
 *
 * It prices the game off the week's slate in that league's scoring and
 * leaves the board as built, rather than rescoring the board for every
 * league on the list, which is a second or two of frozen page a league.
 * The slate has a line for nearly every starter, so the board only
 * stands in for the odd player it leaves out, and the number is the one
 * the matchup tab shows to within a point or two. The matchup tab, which
 * does rescore, is the one to believe when the two differ.
 */

import { useEffect, useMemo, useState } from "preact/hooks";

import type { Listed } from "../lib/availability.ts";
import {
  linesFor, myGameIn, settledGames, standingFor, type GameState,
} from "../lib/matchups.ts";
import {
  listedPlayersWith, PROVIDERS, type League, type Matchup,
} from "../lib/providers.ts";
import { scoredSays, type Player } from "../lib/scoring.ts";
import {
  catchShiftOf, onTheBooks, slateUnder, weekRowsOf, type Slate,
} from "../lib/slate.ts";
import { pct } from "./Advice.tsx";

interface Props {
  league: League;
  /** the coming week's slate, as built */
  slate: Slate;
  /** the board as built, for the players the slate leaves out */
  board: Player[];
  boardPerCatch: number;
  schedule: Record<string, (string | null)[]> | null | undefined;
  /** the injury report as Sleeper has it, which each league's rosters add to */
  listed: Map<string, Listed>;
  /** where every game has got to, or an empty map before the scoreboard reads */
  states: Map<string, GameState>;
  /** moves with each scoreboard read, so the league's points are read again */
  tick: number;
}

export function LeagueWeek(props: Props) {
  const { league, slate, board, states } = props;
  const [games, setGames] = useState<Matchup[] | null>(null);

  useEffect(() => {
    const asks = PROVIDERS[league.provider]?.matchupsFor;

    if (!asks) {
      return;
    }

    let stale = false;

    asks(league, slate.week)
      .then((got) => { if (!stale) { setGames(got); } })
      // a league that will not answer leaves its card as it was
      .catch(() => undefined);

    return () => { stale = true; };
  }, [league, slate.week, props.tick]);

  const rows = useMemo(() => {
    const rosters = [league.myRoster, ...league.allRosters.map((r) => r.keys)];

    return weekRowsOf(
      league.pays ? slateUnder(slate, league.pays["rec"] ?? 0) : slate,
      onTheBooks(board, rosters),
      props.schedule,
      listedPlayersWith(props.listed, rosters),
    );
  }, [league, slate, board, props.schedule, props.listed]);
  const lines = useMemo(
    () => linesFor(board, slate.week, catchShiftOf(league.pays ?? {}, props.boardPerCatch)),
    [board, slate.week, league.pays, props.boardPerCatch],
  );
  const read = useMemo(() => {
    if (!games) {
      return null;
    }

    const ours = myGameIn(
      settledGames(games, rows, states, lines), league.team, league.userId);

    if (!ours) {
      return { against: null, odds: null, live: false } as const;
    }

    const { odds } = standingFor(ours.game, { rows, states, lines, remainder: null });
    const live = ours.game.sides.some((side) => side.points > 0);

    return {
      against: ours.against.owner,
      odds: odds[ours.at]!,
      live,
      score: `${scoredSays(ours.side.points)}–${scoredSays(ours.against.points)}`,
    } as const;
  }, [games, rows, states, lines, league]);

  if (!read) {
    return <div class="lweek waiting">week {slate.week}</div>;
  }

  if (!read.against || read.odds === null) {
    return <div class="lweek">no game in week {slate.week}</div>;
  }

  const tone = read.odds >= 0.6 ? "up" : read.odds <= 0.4 ? "no" : "even";

  return (
    <div class="lweek">
      <span class="vs">
        week {slate.week} vs <b>{read.against}</b>
        {read.live && "score" in read && <i>{read.score}</i>}
      </span>
      <span class={"odds " + tone}>
        {pct(read.odds)}<small>to win</small>
      </span>
    </div>
  );
}
