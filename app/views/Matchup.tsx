/**
 * Your week: the lineup you would set, and the game you are setting it
 * for.
 *
 * Every bench player is priced the way the matchup card prices a swap:
 * your win probability against this week's opponent if he starts instead
 * of whoever is in the slot. Only swaps that gain you something are
 * listed, since a slot with five losing options under it says nothing.
 *
 * A player whose game has kicked off is still shown, marked locked,
 * because knowing you missed him is worth more than hiding him.
 */

import type { ComponentChildren } from "preact";
import { useMemo } from "preact/hooks";

import type { Listed } from "../lib/availability.ts";
import { leadFor, type Explanation } from "../lib/explain.ts";
import {
  alternativesFor, lineFor, linesFor, myGameIn, settledGames, standingFor,
  starterState, type GameState, type Lines, type SlotChoice,
} from "../lib/matchups.ts";
import type { League, Matchup, Side } from "../lib/providers.ts";
import { scoredSays, type Pays, type Player } from "../lib/scoring.ts";
import {
  catchShiftOf, hurtWord, type Slate, type SlateRow, type WeekRef,
} from "../lib/slate.ts";
import { WeatherMark } from "./WeatherMark.tsx";
import { Advice, gainPct, nameOf, pct } from "./Advice.tsx";
import { injuryBadge } from "./Draft.tsx";
import { PlayerName } from "./PlayerName.tsx";
import { Game } from "./Matchups.tsx";
import { Reading } from "./Reading.tsx";
import { useLiveWeek, type WeekPoll } from "./scoreboard.ts";

interface Props {
  weeks: WeekRef[];
  picked: WeekRef | null;
  onWeek: (w: WeekRef) => void;
  slate: Slate | null;
  /** this week's games in your league, for the one you are in */
  games: Matchup[];
  rows: Map<string, SlateRow>;
  /** the board in this league's terms, for the players the slate leaves out */
  players: Player[];
  /** who the injury report has listed, so a zero projection says why */
  listed: Map<string, Listed>;
  /** your own team's name in the league */
  mine: string | null;
  /** and the provider's id for that team, where it has one */
  mineId?: string | null;
  slots: string[] | null;
  /** the league's own name, which the shared picture is headed with */
  league?: string;
  /** what this league pays, for playing out the rest of a live game */
  pays?: Pays;
  /** what the board paid a catch, so its week lines move to this league's */
  boardPerCatch?: number | undefined;
  /** whose scoreboard says where each game is, which is the league's own */
  provider?: League["provider"] | undefined;
  /** the page's scoreboard poll, which the league's points are read on too */
  scoreboard?: WeekPoll | null;
  status?: string;
  /** opens a player's sheet, since every name on the page opens one */
  onMore?: (key: string) => void;
}

const signed = (gains: number) =>
  gains > 0 ? gainPct(gains) : (100 * gains).toFixed(0) + "%";

/** one figure with what it measures over it, so no number is bare */
function Fig(
  { label, children }: { label: string; children: ComponentChildren },
) {
  return (
    <span class="fig">
      <i>{label}</i>
      {children}
    </span>
  );
}

/**
 * What a player is worth this week, on his own row or under his slot.
 *
 * Proj is his projection for the week, whatever his game has done since.
 * It used to be the part of it still to come, which read as a zero
 * beside a player who had already scored fifteen points.
 */
function Numbers(
  { line, left }: {
    line: ReturnType<typeof lineFor>;
    /** how much of his game is still to play */
    left: number;
  },
) {
  if (!line) {
    return <span class="slot-fig">no projection</span>;
  }

  return (
    <>
      <Fig label="proj">
        {line.blend.toFixed(1)}
        {line.stock ? <small> stock</small> : null}
      </Fig>
      {left > 0 && left < 1 && (
        <Fig label="still to come">{(line.blend * left).toFixed(1)}</Fig>
      )}
      <Fig label="floor to ceiling">
        {line.spread.low.toFixed(1)} to {line.spread.high.toFixed(1)}
      </Fig>
    </>
  );
}

/**
 * What the injury report says about him, next to his name, so a player
 * projected at zero is not a mystery.
 */
function InjuryBadge(
  { his, row }: { his: Listed | undefined; row?: SlateRow | undefined },
) {
  const badge = injuryBadge(hurtWord(his, row));

  if (!badge) {
    return null;
  }

  return (
    <span class={"badge " + badge.badgeHow} title={badge.badgeTitle}>
      {badge.badge}
    </span>
  );
}

/** everything worth flagging beside a name: what he is listed as, and the sky */
function Marks(
  { his, row }: { his: Listed | undefined; row: SlateRow | undefined },
) {
  return (
    <>
      <InjuryBadge his={his} row={row} />
      {row && <WeatherMark row={row} />}
    </>
  );
}

/**
 * Where the swap's win probability comes from, shown only on the slots
 * a reader cannot settle from the two projections.
 *
 * These four add up to the swap, and most of them are a fraction of a
 * point, so this is the one place a tenth is worth printing.
 */
function Why({ why }: { why: Explanation }) {
  const part = (share: number) =>
    (share > 0 ? "+" : "") + (100 * share).toFixed(1) + "%";
  const pieces: [string, number][] = [
    ["points", why.points],
    ["range", why.spread],
    ["their game", why.opponent],
    ["your lineup", why.ownLineup],
  ];

  return (
    <p class="why" title={leadFor(why)}>
      {pieces.map(([said, worth]) => (
        <span key={said} class="piece">
          {said} <b>{part(worth)}</b>
        </span>
      ))}
      <span class="piece">
        net <b>{part(why.gains)}</b>
      </span>
    </p>
  );
}

function Slot(
  { choice, rows, states, lines, listed, onMore }: {
    choice: SlotChoice;
    rows: Map<string, SlateRow>;
    states: Map<string, GameState>;
    lines: Lines;
    listed: Map<string, Listed>;
    onMore?: ((key: string) => void) | undefined;
  },
) {
  const at = (key: string, slot?: string) => {
    const line = lineFor({ key, slot }, rows, lines);
    const state = starterState({ key, slot }, rows, states, lines);

    return { line, left: state?.left ?? 1 };
  };
  const his = at(choice.starter.key, choice.slot);
  /**
   * Only the swaps that gain you something. Listing the losing ones put
   * the same five bench players under every running back slot, which is
   * five screens of rows telling you to do nothing.
   */
  const better = choice.options.filter((option) => option.gains > 0);

  return (
    <section class="slot-card">
      <h3>
        <span class="chip">{choice.slot}</span>
        <PlayerName
          name={nameOf(
            choice.starter.key, rows, lines, choice.starter.name)}
          team={his.line?.team}
          onOpen={onMore ? () => onMore(choice.starter.key) : undefined}
        />
        <Marks
          his={listed.get(choice.starter.key)}
          row={rows.get(choice.starter.key)}
        />
        {choice.locked && <span class="badge even">locked</span>}
      </h3>

      <div class="slot-figs">
        {/* nothing is scored before kickoff, and a zero there reads as
            a player who went out and did nothing */}
        {his.left < 1 && (
          <Fig label="scored">{scoredSays(choice.starter.points)}</Fig>
        )}
        <Numbers line={his.line} left={his.left} />
      </div>

      {better.length > 0 && (
        <>
          <div class="over">bench</div>
          <ul class="options">
            {better.map((option) => {
              const other = at(option.key);

              return (
                <li key={option.key} class={option.locked ? "shut" : ""}>
                  <PlayerName
                    name={nameOf(option.key, rows, lines, option.name)}
                    team={other.line?.team}
                    onOpen={onMore ? () => onMore(option.key) : undefined}
                  />
                  <Numbers line={other.line} left={other.left} />
                  <Marks
                    his={listed.get(option.key)}
                    row={rows.get(option.key)}
                  />
                  <span class="fig delta up">
                    <i>win %</i>{signed(option.gains)}
                  </span>
                  <Fig label="outscores him">{pct(option.outscores)}</Fig>
                  {option.locked && <span class="badge even">locked</span>}
                  {option.why && <Why why={option.why} />}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

function Lineup(
  { side, against, slots, rows, states, lines, remainder, listed, onMore }: {
    side: Side;
    against: Side;
    slots: string[] | null;
    rows: Map<string, SlateRow>;
    states: Map<string, GameState>;
    lines: Lines;
    remainder: Map<string, number[]> | null;
    listed: Map<string, Listed>;
    onMore?: ((key: string) => void) | undefined;
  },
) {
  const choices = useMemo(
    () => alternativesFor(side, against, slots, { rows, states, lines, remainder }),
    [side, against, slots, rows, states, lines, remainder],
  );

  return (
    <>
      {choices.map((choice, i) => (
        <Slot
          key={choice.starter.key + i}
          choice={choice}
          rows={rows}
          states={states}
          lines={lines}
          listed={listed}
          onMore={onMore}
        />
      ))}
    </>
  );
}

export function MyMatchup(props: Props) {
  const { mine, mineId, rows, slots, slate, onMore } = props;
  const { states, remainder, trouble } = useLiveWeek(
    props.picked?.season, props.picked?.week, props.pays ?? {},
    props.provider, props.scoreboard);

  const lines = useMemo(
    () => linesFor(
      props.players, props.picked?.week,
      catchShiftOf(props.pays ?? {}, props.boardPerCatch)),
    [props.players, props.picked, props.pays, props.boardPerCatch]);
  const games = useMemo(
    () => settledGames(props.games, rows, states, lines),
    [props.games, rows, states, lines],
  );
  const ours = useMemo(
    () => myGameIn(games, mine, mineId), [games, mine, mineId]);
  // the headline and the card under it have to price the same game
  const odds = useMemo(
    () => ours && states
      ? standingFor(ours.game, { rows, states, lines, remainder }).odds[ours.at]
      : undefined,
    [ours, rows, states, lines, remainder],
  );

  if (!props.weeks.length) {
    return (
      <div class="empty">
        <b>No week has been built yet.</b> Weekly projections need a few
        games of this year's snaps and targets, so they turn on about a
        month in. Until then use <b>draft</b> and <b>team</b>.
      </div>
    );
  }

  return (
    <>
      <div class="controls">
        <label>
          week{" "}
          <select
            value={props.picked ? String(props.picked.week) : ""}
            onChange={(e) => {
              const want = Number(e.currentTarget.value);
              const found = props.weeks.find((w) => w.week === want);

              if (found) {
                props.onWeek(found);
              }
            }}
          >
            {props.weeks.map((w) => (
              <option key={w.file} value={String(w.week)}>
                week {w.week}
              </option>
            ))}
          </select>
        </label>

        <span id="status">{props.status ?? ""}</span>
      </div>

      {trouble && <p class="hint">{trouble}</p>}

      {slate?.preseason && (
        <p class="hint">
          Preseason: projections are based on last season.
        </p>
      )}

      {ours && states && (
        <>
          <Advice
            side={ours.side}
            against={ours.against}
            slots={slots}
            rows={rows}
            states={states}
            lines={lines}
            odds={odds}
            remainder={remainder}
            onMore={onMore}
          />
          <p class="hint">
            vs {ours.against.owner}
          </p>
          <Lineup
            side={ours.side}
            against={ours.against}
            slots={slots}
            rows={rows}
            states={states}
            lines={lines}
            remainder={remainder}
            listed={props.listed}
            onMore={onMore}
          />

          <h2>your game</h2>
          <Game
            game={ours.game}
            rows={rows}
            states={states}
            slots={slots}
            lines={lines}
            mine={ours.at}
            remainder={remainder}
            onMore={onMore}
            share={props.league && props.picked
              ? { league: props.league, week: props.picked.week }
              : undefined}
            withAdvice={false}
          />
        </>
      )}

      {ours && !states && <Reading>reading the scoreboard...</Reading>}

      {!ours && (
        <p class="hint">
          No game this week. Rankings are under <b>players</b>.
        </p>
      )}
    </>
  );
}
