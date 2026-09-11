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
  bestLineupFor, gameStates, projectedFor, standingFor, starterState,
  type GameState, type Lines,
} from "../lib/matchups.ts";
import type { Matchup, Side } from "../lib/providers.ts";
import type { Player } from "../lib/scoring.ts";
import type { SlateRow } from "../lib/slate.ts";

/** how often the scoreboard is read again while a game is on */
const EVERY = 60_000;

interface Props {
  games: Matchup[];
  rows: Map<string, SlateRow>;
  /** the board in this league's terms, for the men the slate leaves out */
  men: Player[];
  /** your own team's name in the league, so your game can lead */
  mine: string;
  /** the seats the league starts, for the lineup it says you could put out */
  slots: string[] | null;
  season: number;
  week: number;
  status?: string;
}

const pct = (share: number) => (100 * share).toFixed(0) + "%";

/** done, playing or yet to play, as a word and a class */
const MARK: Record<GameState["where"] | "none", [string, string]> = {
  post: ["done", "even"],
  in: ["playing", "up"],
  pre: ["to play", "warn"],
  none: ["no line", "even"],
};

function Lineup(
  { side, rows, states, lines }: {
    side: Side;
    rows: Map<string, SlateRow>;
    states: Map<string, GameState>;
    lines: Lines;
  },
) {
  return (
    <table class="lineup">
      <tbody>
        {side.starters.map((starter, i) => {
          const row = rows.get(starter.key);
          const man = lines.get(starter.key);
          const state = starterState(starter, rows, states, lines);
          const [word, tone] = MARK[state?.where ?? "none"];
          const projected = projectedFor(starter.key, rows, lines);

          return (
            <tr key={starter.key + i}>
              <td class="slot">{starter.slot}</td>
              <td>{row?.name ?? man?.name ?? starter.key}</td>
              <td class="val">{starter.points.toFixed(1)}</td>
              <td class="val proj">
                {projected === null || !state || state.left <= 0
                  ? ""
                  : (projected * state.left).toFixed(1)}
              </td>
              <td class="state">
                <span class={"badge " + tone}>{word}</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * Your own lineup against the best one you could put out, when the card
 * is yours. Both are drawn against the same opponent, so the difference
 * between the two is the lineup rather than the drawing.
 */
function Advice(
  { game, at, slots, rows, states, lines, odds }: {
    game: Matchup;
    at: number;
    slots: string[] | null;
    rows: Map<string, SlateRow>;
    states: Map<string, GameState>;
    lines: Lines;
    odds: number;
  },
) {
  const best = useMemo(
    () => bestLineupFor(
      game.sides[at]!, game.sides[1 - at]!, slots, rows, states,
      undefined, lines),
    [game, at, slots, rows, states, lines],
  );
  const named = (key: string) =>
    rows.get(key)?.name ?? lines.get(key)?.name ?? key;

  if (!best.swaps.length) {
    return (
      <p class="hint">
        You win {pct(odds)} of the time, and no change to the lineup does
        better.
      </p>
    );
  }

  return (
    <p class="hint">
      You win {pct(odds)} of the time. The best lineup wins{" "}
      {pct(best.odds)}:{" "}
      {best.swaps.map((swap, i) => (
        <span key={swap.starts}>
          {i > 0 ? ", " : ""}
          start {named(swap.starts)} over {named(swap.benches)}{" "}
          ({swap.slot}), +{(100 * swap.gains).toFixed(1)}%
        </span>
      ))}.
    </p>
  );
}

function Game(
  { game, rows, states, slots, lines, mine }: {
    game: Matchup;
    rows: Map<string, SlateRow>;
    states: Map<string, GameState>;
    slots: string[] | null;
    lines: Lines;
    mine: number;
  },
) {
  const { odds, projected } = useMemo(
    () => standingFor(game, rows, states, lines),
    [game, rows, states, lines],
  );

  return (
    <div class={"card plain matchup" + (mine >= 0 ? " on" : "")}>
      {game.sides.map((side, at) => (
        <div class="team" key={side.owner + at}>
          <span class="nm">{side.owner}</span>
          <span class="big">{side.points.toFixed(1)}</span>
          <span class="val">{projected[at]!.toFixed(1)} projected</span>
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
      {mine >= 0 && (
        <Advice
          game={game}
          at={mine}
          slots={slots}
          rows={rows}
          states={states}
          lines={lines}
          odds={odds[mine]!}
        />
      )}
      <div class="lineups">
        {game.sides.map((side, at) => (
          <Lineup
            key={side.owner + at}
            side={side}
            rows={rows}
            states={states}
            lines={lines}
          />
        ))}
      </div>
    </div>
  );
}

export function Matchups(
  { games, rows, men, mine, slots, season, week, status }: Props,
) {
  const lines = useMemo(
    () => new Map(men.map((p) => [p.key, p])), [men]);
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

    gameStates(season, week)
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
            slots={slots}
            lines={lines}
            mine={game.sides.findIndex((s) => s.owner === mine)}
          />
        ))}
      </div>
    </>
  );
}
