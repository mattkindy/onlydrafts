/**
 * Every head to head in the league this week, with a live win chance.
 *
 * The points are whatever the league has scored so far. The chance is
 * drawn from the week's projections, with only the part of each game
 * still to play counted, so a side that is behind with everybody done
 * reads nought and one sitting on a lead with a back yet to play does
 * not read as safe.
 *
 * Your own game comes first. While any game is under way the scoreboard
 * is read again every minute; when none is, it is read once.
 */

import { useEffect, useMemo, useState } from "preact/hooks";

import {
  gameStates, oddsFor, starterState, type GameState,
} from "../lib/matchups.ts";
import type { Matchup, Side } from "../lib/providers.ts";
import type { SlateRow } from "../lib/slate.ts";

/** how often the scoreboard is read again while a game is on */
const EVERY = 60_000;

interface Props {
  games: Matchup[];
  rows: Map<string, SlateRow>;
  /** your own team's name in the league, so your game can lead */
  mine: string;
  week: number;
  status?: string;
}

const pct = (share: number) => (100 * share).toFixed(0) + "%";

/** done, playing or yet to play, as a word and a class */
const MARK: Record<GameState["where"], [string, string]> = {
  post: ["done", "even"],
  in: ["playing", "up"],
  pre: ["to play", "warn"],
};

function Lineup(
  { side, rows, states }: {
    side: Side;
    rows: Map<string, SlateRow>;
    states: Map<string, GameState>;
  },
) {
  return (
    <table class="lineup">
      <tbody>
        {side.starters.map((starter, i) => {
          const row = rows.get(starter.key);
          const [word, tone] = MARK[starterState(starter, rows, states).where];

          return (
            <tr key={starter.key + i}>
              <td class="slot">{starter.slot}</td>
              <td>{row?.name ?? starter.key}</td>
              <td class="val">{starter.points.toFixed(1)}</td>
              <td><span class={"badge " + tone}>{word}</span></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Game(
  { game, rows, states, mine }: {
    game: Matchup;
    rows: Map<string, SlateRow>;
    states: Map<string, GameState>;
    mine: boolean;
  },
) {
  const odds = useMemo(
    () => oddsFor(game, rows, states),
    [game, rows, states],
  );

  return (
    <div class={"card plain matchup" + (mine ? " on" : "")}>
      {game.sides.map((side, at) => (
        <div class="team" key={side.owner + at}>
          <span class="nm">{side.owner}</span>
          <span class="big">{side.points.toFixed(1)}</span>
          <span class="val">{pct(odds[at]!)} to win</span>
        </div>
      ))}
      <div
        class="odds"
        title={`${game.sides[0].owner} ${pct(odds[0])}, ` +
          `${game.sides[1].owner} ${pct(odds[1])}`}
      >
        <u style={{ width: pct(odds[0]) }} />
      </div>
      <div class="lineups">
        {game.sides.map((side, at) => (
          <Lineup key={side.owner + at} side={side} rows={rows} states={states} />
        ))}
      </div>
    </div>
  );
}

export function Matchups({ games, rows, mine, week, status }: Props) {
  const [states, setStates] = useState<Map<string, GameState> | null>(null);
  const [read, setRead] = useState<Date | null>(null);
  const [trouble, setTrouble] = useState("");
  /**
   * Bumped on every read, which is what asks for the next one. Reading
   * inside a timer that depends on the states themselves would rebuild
   * the timer every minute and drift.
   */
  const [reads, setReads] = useState(0);

  useEffect(() => {
    let stale = false;

    gameStates()
      .then((got) => {
        if (!stale) {
          setStates(got);
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
  }, [reads]);

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

  const ordered = useMemo(
    () => [...games].sort((a, b) =>
      Number(b.sides.some((s) => s.owner === mine)) -
      Number(a.sides.some((s) => s.owner === mine))),
    [games, mine],
  );

  return (
    <>
      <p class="hint">
        Week {week}.{" "}
        {read
          ? "Scoreboard read at " + read.toLocaleTimeString() +
            (live ? ", again every minute while a game is on." : ".")
          : "Reading the scoreboard."}
      </p>

      {(status || trouble) && <p class="hint">{status || trouble}</p>}

      {!games.length && <p class="hint">No games for this week yet.</p>}

      <div class="cards wide">
        {states && ordered.map((game, at) => (
          <Game
            key={game.sides[0].owner + "/" + game.sides[1].owner + at}
            game={game}
            rows={rows}
            states={states}
            mine={game.sides.some((s) => s.owner === mine)}
          />
        ))}
      </div>
    </>
  );
}
