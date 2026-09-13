/**
 * Every head to head in the league this week, with a live win
 * probability.
 *
 * The points are whatever the league has scored so far. The probability
 * is drawn from the week's projections, counting only the part of each
 * game still to play, so a side behind with everybody done reads nought.
 *
 * A card pairs the two lineups slot by slot. A player who is done shows
 * bright points and no projection, one playing gets a green edge on his
 * side of the row, and one yet to kick off shows a faint one.
 *
 * Your own game lives on the matchup tab, so this view can leave it out.
 */

import { useMemo } from "preact/hooks";

import {
  lineFor, standingFor, starterState,
  type GameState, type Lines,
} from "../lib/matchups.ts";
import type { Matchup, Side } from "../lib/providers.ts";
import type { Pays, Player } from "../lib/scoring.ts";
import type { SlateRow } from "../lib/slate.ts";
import { Advice, nameOf, pct } from "./Advice.tsx";
import { ManName } from "./ManName.tsx";
import { Reading } from "./Reading.tsx";
import { useLiveWeek } from "./scoreboard.ts";

interface Props {
  games: Matchup[];
  rows: Map<string, SlateRow>;
  /** the board in this league's terms, for the players the slate leaves out */
  men: Player[];
  /** your own team's name in the league, so your game can be told apart */
  mine: string;
  /** the slots the league starts, for the lineup it says you could put out */
  slots: string[] | null;
  /** what this league pays, since the remainder engine scores its own plays */
  pays: Pays;
  season: number;
  week: number;
  status?: string;
  /** leave your own game out, since the matchup tab has it */
  withoutMine?: boolean;
  /** opens a man's sheet, since every name on the page opens one */
  onMore?: (key: string) => void;
}

/** one man on one side of a row, mirrored when he is the away side */
function Man(
  { starter, rows, states, lines, at, remainder, onMore }: {
    starter: Side["starters"][number] | undefined;
    rows: Map<string, SlateRow>;
    states: Map<string, GameState>;
    lines: Lines;
    at: 0 | 1;
    remainder: Map<string, number[]> | null;
    onMore?: ((key: string) => void) | undefined;
  },
) {
  if (!starter) {
    return <div class={"man " + (at ? "away" : "home")} />;
  }

  const line = lineFor(starter, rows, lines);
  const state = starterState(starter, rows, states, lines);
  const playing = state?.where === "in";
  const done = !state || state.left <= 0;
  const simmed = done ? undefined : remainder?.get(starter.key);
  const toCome = simmed
    ? simmed.reduce((sum, points) => sum + points, 0) / simmed.length
    : line && !done ? line.blend * (state?.left ?? 1) : null;

  return (
    <div
      class={"man " + (at ? "away" : "home") + (playing ? " live" : "") +
        (done ? " done" : "")}
    >
      <ManName
        name={nameOf(starter.key, rows, lines, starter.name)}
        team={line?.team}
        onOpen={onMore ? () => onMore(starter.key) : undefined}
      />
      <span class="num">
        <b>{starter.points.toFixed(1)}</b>
        <i>
          {toCome === null ? "" : toCome.toFixed(1)}
          {simmed ? " sim" : line?.stock && toCome !== null ? " stock" : ""}
        </i>
      </span>
    </div>
  );
}

type Starter = Side["starters"][number];

/**
 * The rows of one card: a slot, and the player each side has in it.
 *
 * Pairing the two lists by position put one side's kicker opposite the
 * other side's defence whenever the two were set in different orders,
 * and the chip between them then named neither. So each row takes the
 * slot from the first side and fills the other half with that side's
 * first unused starter in the same slot.
 */
export function pairedRows(game: Matchup): {
  slot: string; home?: Starter; away?: Starter;
}[] {
  const left = [...game.sides[0].starters];
  const right = [...game.sides[1].starters];
  const rows: { slot: string; home?: Starter; away?: Starter }[] = [];

  for (const home of left) {
    const at = right.findIndex((s) => s.slot === home.slot);
    const away = at >= 0 ? right.splice(at, 1)[0] : undefined;

    rows.push({ slot: home.slot, home, ...(away ? { away } : {}) });
  }

  for (const away of right) {
    rows.push({ slot: away.slot, away });
  }

  return rows;
}

function Lineups(
  { game, rows, states, lines, remainder, onMore }: {
    game: Matchup;
    rows: Map<string, SlateRow>;
    states: Map<string, GameState>;
    lines: Lines;
    remainder: Map<string, number[]> | null;
    onMore?: ((key: string) => void) | undefined;
  },
) {
  return (
    <div class="lineups">
      {pairedRows(game).map((row, i) => (
        <div class="seat" key={row.slot + i}>
          <Man
            starter={row.home} rows={rows} states={states} lines={lines} at={0}
            remainder={remainder} onMore={onMore}
          />
          <span class="chip">{row.slot}</span>
          <Man
            starter={row.away} rows={rows} states={states} lines={lines} at={1}
            remainder={remainder} onMore={onMore}
          />
        </div>
      ))}
    </div>
  );
}

export function Game(
  {
    game, rows, states, slots, lines, mine, remainder, onMore,
    withAdvice = true,
  }: {
    game: Matchup;
    rows: Map<string, SlateRow>;
    states: Map<string, GameState>;
    slots: string[] | null;
    lines: Lines;
    mine: number;
    remainder: Map<string, number[]> | null;
    onMore?: ((key: string) => void) | undefined;
    /** the matchup tab says this above the lineup, so its card leaves it out */
    withAdvice?: boolean;
  },
) {
  const { odds, projected } = useMemo(
    () => standingFor(
      game, rows, states, lines, undefined, remainder ?? undefined),
    [game, rows, states, lines, remainder],
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
      {mine >= 0 && withAdvice && (
        <Advice
          side={game.sides[mine]!}
          against={game.sides[1 - mine]!}
          slots={slots}
          rows={rows}
          states={states}
          lines={lines}
          odds={odds[mine]!}
          remainder={remainder}
          onMore={onMore}
        />
      )}
      <Lineups
        game={game} rows={rows} states={states} lines={lines}
        remainder={remainder} onMore={onMore}
      />
    </div>
  );
}

export function Matchups(
  {
    games, rows, men, mine, slots, pays, season, week, status, withoutMine,
    onMore,
  }: Props,
) {
  const lines = useMemo(
    () => new Map(men.map((p) => [p.key, p])), [men]);
  const { states, remainder, read, trouble } =
    useLiveWeek(season, week, pays);

  /**
   * Your own game first, or left out entirely when the matchup tab is
   * already showing it.
   */
  const ordered = useMemo(() => {
    const isMine = (game: Matchup) =>
      game.sides.some((s) => s.owner === mine);

    return withoutMine
      ? games.filter((game) => !isMine(game))
      : [...games].sort((a, b) => Number(isMine(b)) - Number(isMine(a)));
  }, [games, mine, withoutMine]);

  return (
    <>
      {read
        ? (
          <p class="hint">
            Week {week}, scores as of {read.toLocaleTimeString()}
          </p>
        )
        : <Reading>reading week {week}'s scoreboard...</Reading>}

      {(status || trouble) && <p class="hint">{status || trouble}</p>}

      {!ordered.length && <p class="hint">No other games this week yet.</p>}

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
            remainder={remainder}
            onMore={onMore}
          />
        ))}
      </div>
    </>
  );
}
