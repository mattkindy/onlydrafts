/**
 * Every head to head in the league this week, with a live win
 * probability.
 *
 * The points are whatever the league has scored so far. The probability
 * is drawn from the week's projections, counting only the part of each
 * game still to play, so a side behind with everybody done reads zero.
 *
 * A card pairs the two lineups slot by slot. A player who is done shows
 * bright points and no projection, one playing gets a green edge on his
 * side of the row, and one yet to kick off shows a faint one.
 *
 * Your own game comes first, so the shared picture of the week has it.
 */

import { useMemo } from "preact/hooks";

import {
  lineFor, standingFor, starterState,
  type GameState, type InGameStatus, type Lines,
} from "../lib/matchups.ts";
import type { Matchup, Side } from "../lib/providers.ts";
import type { Pays, Player } from "../lib/scoring.ts";
import { layoutGame, layoutWeek, shareLayout } from "../lib/shareImage.ts";
import type { ShareGame } from "../lib/shareImage.ts";
import type { SlateRow } from "../lib/slate.ts";
import { Advice, nameOf, pct } from "./Advice.tsx";
import { PlayerName } from "./PlayerName.tsx";
import { Reading } from "./Reading.tsx";
import { useLiveWeek } from "./scoreboard.ts";

interface Props {
  games: Matchup[];
  rows: Map<string, SlateRow>;
  /** the board in this league's terms, for the players the slate leaves out */
  players: Player[];
  /** your own team's name in the league, so your game can be told apart */
  mine: string;
  /** the slots the league starts, for the lineup it says you could put out */
  slots: string[] | null;
  /** what this league pays, since the remainder engine scores its own plays */
  pays: Pays;
  season: number;
  week: number;
  /** the league's own name, which the shared picture is headed with */
  league?: string;
  status?: string;
  /** opens a player's sheet, since every name on the page opens one */
  onMore?: (key: string) => void;
}

/** what the hover says about a player the sideline has */
const HURT_SAYS: Record<InGameStatus, string> = {
  out: "out for the game",
  doubtful: "doubtful to return",
  questionable: "questionable to return",
};

/** one player on one side of a row, mirrored when he is the away side */
function StarterCell(
  { starter, rows, states, lines, at, remainder, stillToCome, onMore }: {
    starter: Side["starters"][number] | undefined;
    rows: Map<string, SlateRow>;
    states: Map<string, GameState>;
    lines: Lines;
    at: 0 | 1;
    remainder: Map<string, number[]> | null;
    /** what each starter still adds on average, from the card's own draws */
    stillToCome: Map<string, number>;
    onMore?: ((key: string) => void) | undefined;
  },
) {
  if (!starter) {
    return <div class={"player " + (at ? "away" : "home")} />;
  }

  const line = lineFor(starter, rows, lines);
  const state = starterState(starter, rows, states, lines);
  const playing = state?.where === "in";
  const hurt = state?.hurt?.get(starter.key);
  const done = !state || state.left <= 0 || hurt === "out";
  const simmed = !done && remainder?.has(starter.key);
  const toCome = done ? null : stillToCome.get(starter.key) ?? null;
  // what he is on course to finish with, since the bare remainder
  // read like a second projection nobody could place
  const onCourse = toCome === null ? null : starter.points + toCome;
  // against his pregame number, once his game has started
  const swing = onCourse !== null && line && playing
    ? onCourse - line.blend : 0;
  const tone = swing > 0 ? " up" : swing < 0 ? " below" : "";
  const hurtSays = hurt ? HURT_SAYS[hurt] : "";
  const reading = toCome === null
    ? hurtSays || undefined
    : `projected ${onCourse!.toFixed(1)}` +
      (line && playing ? ` against ${line.blend.toFixed(1)} pregame` : "") +
      `, ${toCome.toFixed(1)} still to come` +
      (simmed ? ", from the simulation" : line?.stock ? ", a stock week" : "") +
      (hurtSays ? `, ${hurtSays}` : "");

  return (
    <div
      class={"player " + (at ? "away" : "home") + (playing ? " live" : "") +
        (done ? " done" : "")}
    >
      <PlayerName
        name={nameOf(starter.key, rows, lines, starter.name)}
        team={line?.team}
        onOpen={onMore ? () => onMore(starter.key) : undefined}
      />
      <span class="num">
        <b>{starter.points.toFixed(1)}</b>
        <i class={tone} title={reading}>
          {onCourse === null ? "" : onCourse.toFixed(1)}
        </i>
      </span>
    </div>
  );
}

type Starter = Side["starters"][number];

/** where the league name and week come from, for a picture to share */
export interface ShareOf {
  league: string;
  week: number;
}

/** one card's worth of the picture: the two sides as the card reads them */
export function shareGameOf(
  game: Matchup, odds: [number, number], projected: [number, number],
): ShareGame {
  return {
    sides: [0, 1].map((at) => ({
      name: game.sides[at]!.owner,
      points: game.sides[at]!.points,
      projected: projected[at]!,
      odds: odds[at]!,
    })) as ShareGame["sides"],
  };
}

function ShareButton(
  { onShare, label, only }: {
    onShare: () => void; label: string; only?: boolean;
  },
) {
  return (
    <button
      class={"quiet share" + (only ? " icon" : "")}
      title="save this as a picture for the group chat"
      aria-label={label}
      onClick={onShare}
    >
      <span aria-hidden="true">&#x2934;</span>
      {!only && label}
    </button>
  );
}

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
  { game, rows, states, lines, remainder, stillToCome, onMore }: {
    game: Matchup;
    rows: Map<string, SlateRow>;
    states: Map<string, GameState>;
    lines: Lines;
    remainder: Map<string, number[]> | null;
    /** what each starter still adds on average, from the card's own draws */
    stillToCome: Map<string, number>;
    onMore?: ((key: string) => void) | undefined;
  },
) {
  return (
    <div class="lineups">
      {pairedRows(game).map((row, i) => (
        <div class="slot" key={row.slot + i}>
          <StarterCell
            starter={row.home} rows={rows} states={states} lines={lines} at={0}
            remainder={remainder} stillToCome={stillToCome} onMore={onMore}
          />
          <span class="chip">{row.slot}</span>
          <StarterCell
            starter={row.away} rows={rows} states={states} lines={lines} at={1}
            remainder={remainder} stillToCome={stillToCome} onMore={onMore}
          />
        </div>
      ))}
    </div>
  );
}

export function Game(
  {
    game, rows, states, slots, lines, mine, remainder, onMore, share,
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
    /** with a league and a week, the card can be shared as a picture */
    share?: ShareOf | undefined;
    /** the matchup tab says this above the lineup, so its card leaves it out */
    withAdvice?: boolean;
  },
) {
  const { odds, projected, toCome } = useMemo(
    () => standingFor(
      game, rows, states, lines, undefined, remainder ?? undefined),
    [game, rows, states, lines, remainder],
  );

  return (
    <div
      class={"card plain matchup" + (mine >= 0 ? " on" : "") +
        (withAdvice ? "" : " alone")}
    >
      {game.sides.map((side, at) => (
        <div class={"team" + (at ? " away" : "")} key={side.owner + at}>
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
      {share && (
        <ShareButton
          only
          label="share"
          onShare={() => shareLayout(layoutGame(
            share.league, share.week, shareGameOf(game, odds, projected)))}
        />
      )}
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
        remainder={remainder} stillToCome={toCome} onMore={onMore}
      />
    </div>
  );
}

export function Matchups(
  {
    games, rows, players, mine, slots, pays, season, week, league, status,
    onMore,
  }: Props,
) {
  const lines = useMemo(
    () => new Map(players.map((p) => [p.key, p])), [players]);
  const { states, remainder, read, trouble } =
    useLiveWeek(season, week, pays);

  /** your own game first */
  const ordered = useMemo(() => {
    const isMine = (game: Matchup) =>
      game.sides.some((s) => s.owner === mine);

    return [...games].sort((a, b) => Number(isMine(b)) - Number(isMine(a)));
  }, [games, mine]);

  const shareWeek = () => {
    if (!states || !league) {
      return;
    }

    shareLayout(layoutWeek({
      league,
      week,
      games: ordered.map((game) => {
        const { odds, projected } = standingFor(
          game, rows, states, lines, undefined, remainder ?? undefined);

        return shareGameOf(game, odds, projected);
      }),
    }));
  };

  return (
    <>
      <div class="sharebar">
        {read
          ? (
            <p class="hint">
              Week {week}, scores as of {read.toLocaleTimeString()}
            </p>
          )
          : <Reading>reading week {week}'s scoreboard...</Reading>}

        {league && states && ordered.length > 0 && (
          <ShareButton label="share week" onShare={shareWeek} />
        )}
      </div>

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
            share={league ? { league, week } : undefined}
          />
        ))}
      </div>
    </>
  );
}
