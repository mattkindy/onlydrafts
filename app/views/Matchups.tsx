/**
 * Every head to head in the league this week, with a live win chance.
 *
 * The points are whatever the league has scored so far. The chance is
 * drawn from the week's projections, counting only the part of each
 * game still to play, so a side behind with everybody done reads nought.
 *
 * A card pairs the two lineups seat by seat. A man who is done shows
 * bright points and no projection, a man playing gets a green edge on
 * his side of the row, and a man yet to kick off shows a faint one.
 *
 * Your own game comes first, and the scoreboard is read again every
 * minute while any game is under way.
 */

import { useEffect, useMemo, useState } from "preact/hooks";

import {
  gameStates, lineFor, standingFor, starterState,
  type GameState, type Lines,
} from "../lib/matchups.ts";
import type { Matchup, Side } from "../lib/providers.ts";
import type { Player } from "../lib/scoring.ts";
import type { SlateRow } from "../lib/slate.ts";
import { Advice, nameOf, pct } from "./Advice.tsx";
import { ManName } from "./ManName.tsx";

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

/** one man on one side of a row, mirrored when he is the away side */
function Man(
  { starter, rows, states, lines, at }: {
    starter: Side["starters"][number] | undefined;
    rows: Map<string, SlateRow>;
    states: Map<string, GameState>;
    lines: Lines;
    at: 0 | 1;
  },
) {
  if (!starter) {
    return <div class={"man " + (at ? "away" : "home")} />;
  }

  const line = lineFor(starter, rows, lines);
  const state = starterState(starter, rows, states, lines);
  const playing = state?.where === "in";
  const done = !state || state.left <= 0;
  const toCome = line && !done ? line.blend * (state?.left ?? 1) : null;

  return (
    <div
      class={"man " + (at ? "away" : "home") + (playing ? " live" : "") +
        (done ? " done" : "")}
    >
      <ManName name={nameOf(starter.key, rows, lines)} team={line?.team} />
      <span class="num">
        <b>{starter.points.toFixed(1)}</b>
        <i>
          {toCome === null ? "" : toCome.toFixed(1)}
          {line?.stock && toCome !== null ? " stock" : ""}
        </i>
      </span>
    </div>
  );
}

/**
 * The two lineups paired seat by seat. The sides can be set differently,
 * so they are paired by position in the list and a side with fewer men
 * leaves its half of the row empty.
 */
function Lineups(
  { game, rows, states, lines }: {
    game: Matchup;
    rows: Map<string, SlateRow>;
    states: Map<string, GameState>;
    lines: Lines;
  },
) {
  const deep = Math.max(
    game.sides[0].starters.length, game.sides[1].starters.length);

  return (
    <div class="lineups">
      {Array.from({ length: deep }, (_, i) => {
        const home = game.sides[0].starters[i];
        const away = game.sides[1].starters[i];

        return (
          <div class="seat" key={i}>
            <Man starter={home} rows={rows} states={states} lines={lines} at={0} />
            <span class="chip">{home?.slot ?? away?.slot ?? ""}</span>
            <Man starter={away} rows={rows} states={states} lines={lines} at={1} />
          </div>
        );
      })}
    </div>
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
          <span class="val">{projected[at]!.toFixed(1)} proj</span>
          <span class="val win">{pct(odds[at]!)}</span>
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
          side={game.sides[mine]!}
          against={game.sides[1 - mine]!}
          slots={slots}
          rows={rows}
          states={states}
          lines={lines}
          odds={odds[mine]!}
        />
      )}
      <Lineups game={game} rows={rows} states={states} lines={lines} />
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
