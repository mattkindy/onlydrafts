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

import { useMemo, useState } from "preact/hooks";

import type { Listed } from "../lib/availability.ts";
import { leadFor, type Explanation } from "../lib/explain.ts";
import {
  alternativesFor, lineFor, myGameIn, starterState,
  type GameState, type Lines, type SlotChoice,
} from "../lib/matchups.ts";
import type { Matchup, Side } from "../lib/providers.ts";
import type { Pays, Player } from "../lib/scoring.ts";
import type { Slate, SlateRow, WeekRef } from "../lib/slate.ts";
import { Advice, nameOf } from "./Advice.tsx";
import { injuryBadge } from "./Draft.tsx";
import { ManName } from "./ManName.tsx";
import { Game } from "./Matchups.tsx";
import { Reading } from "./Reading.tsx";
import { useLiveWeek } from "./scoreboard.ts";
import { WeekRanks } from "./WeekRanks.tsx";

interface Props {
  weeks: WeekRef[];
  picked: WeekRef | null;
  onWeek: (w: WeekRef) => void;
  slate: Slate | null;
  /** the players on your team, or nothing when no league is connected */
  roster: Set<string> | null;
  /** this week's games in your league, for the one you are in */
  games: Matchup[];
  rows: Map<string, SlateRow>;
  /** the board in this league's terms, for the players the slate leaves out */
  men: Player[];
  /** who the injury report has listed, so a nought projection says why */
  listed: Map<string, Listed>;
  /** your own team's name in the league */
  mine: string | null;
  slots: string[] | null;
  /** what this league pays, for playing out the rest of a live game */
  pays?: Pays;
  status?: string;
}

const signed = (gains: number) =>
  (gains > 0 ? "+" : "") + (100 * gains).toFixed(1) + "%";

/** what a man is worth this week, as the seat headings and options read it */
function Numbers(
  { line, left, named }: {
    line: ReturnType<typeof lineFor>;
    /** how much of his game is still to play */
    left: number;
    /**
     * Whether to say the number is a projection. The seat's own heading
     * has his points beside it and needs telling apart; a bench man's
     * row has nothing to confuse it with.
     */
    named?: boolean;
  },
) {
  if (!line) {
    return <span class="seat-fig">no projection</span>;
  }

  return (
    <span class="seat-fig">
      <b>{(line.blend * left).toFixed(1)}</b>{named ? " proj" : ""}{" "}
      <i>
        {line.spread.low.toFixed(1)} to {line.spread.high.toFixed(1)}
      </i>
      {line.stock && <i> stock</i>}
    </span>
  );
}

/**
 * What the office says about him, next to his name, so a man projected at
 * nought is not a mystery.
 */
function Office({ his }: { his: Listed | undefined }) {
  const badge = injuryBadge(his);

  if (!badge) {
    return null;
  }

  return (
    <span class={"badge " + badge.badgeHow} title={badge.badgeTitle}>
      {badge.badge}
    </span>
  );
}

/**
 * Where the swap's win chance comes from, shown only on the seats a
 * reader cannot settle from the two projections.
 */
function Why({ why }: { why: Explanation }) {
  const gap = why.projected.candidate - why.projected.starter;
  const pieces: [string, number][] = [
    ["points", why.points],
    ["range", why.spread],
    ["their game", why.opponent],
    ["your lineup", why.ownLineup],
  ];

  return (
    <p class="why">
      <span class="said">
        {(gap > 0 ? "+" : "") + gap.toFixed(1)} projected points, and{" "}
        {leadFor(why)}
      </span>
      {pieces.map(([said, worth]) => (
        <span key={said} class="piece">
          {said} <b>{signed(worth)}</b>
        </span>
      ))}
      <span class="piece">
        net <b>{signed(why.gains)}</b>
      </span>
    </p>
  );
}

function Seat(
  { choice, rows, states, lines, listed }: {
    choice: SlotChoice;
    rows: Map<string, SlateRow>;
    states: Map<string, GameState>;
    lines: Lines;
    listed: Map<string, Listed>;
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
    <section class="seat-card">
      <h3>
        <span class="chip">{choice.slot}</span>
        <ManName
          name={nameOf(choice.starter.key, rows, lines)}
          team={his.line?.team}
        />
        <span class="now">{choice.starter.points.toFixed(1)}</span>
        <Numbers line={his.line} left={his.left} named />
        <Office his={listed.get(choice.starter.key)} />
        {choice.locked && <span class="badge even">locked</span>}
      </h3>

      {better.length > 0 && (
        <>
          <div class="over">bench</div>
          <ul class="options">
            {better.map((option) => {
              const other = at(option.key);

              return (
                <li key={option.key} class={option.locked ? "shut" : ""}>
                  <ManName
                    name={nameOf(option.key, rows, lines)}
                    team={other.line?.team}
                  />
                  <Numbers line={other.line} left={other.left} />
                  <Office his={listed.get(option.key)} />
                  <span class={"delta" + (option.gains > 0 ? " up" : "")}>
                    {signed(option.gains)}
                  </span>
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
  { side, against, slots, rows, states, lines, listed }: {
    side: Side;
    against: Side;
    slots: string[] | null;
    rows: Map<string, SlateRow>;
    states: Map<string, GameState>;
    lines: Lines;
    listed: Map<string, Listed>;
  },
) {
  const choices = useMemo(
    () => alternativesFor(side, against, slots, rows, states, undefined, lines),
    [side, against, slots, rows, states, lines],
  );

  return (
    <>
      {choices.map((choice, i) => (
        <Seat
          key={choice.starter.key + i}
          choice={choice}
          rows={rows}
          states={states}
          lines={lines}
          listed={listed}
        />
      ))}
    </>
  );
}

export function MyMatchup(props: Props) {
  const { games, mine, rows, slots, slate, roster } = props;
  const [wholeWeek, setWholeWeek] = useState(false);
  const { states, remainder, trouble } = useLiveWeek(
    props.picked?.season, props.picked?.week, props.pays ?? {});

  const lines = useMemo(
    () => new Map(props.men.map((p) => [p.key, p])), [props.men]);
  const ours = useMemo(() => myGameIn(games, mine), [games, mine]);

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
          Nobody has played a game yet, so these come from last season's
          per-game rates over this season's schedule.
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
          />
          <p class="hint">
            Against {ours.against.owner} this week. Each player is priced by
            what starting him does to your win probability.
          </p>
          <Lineup
            side={ours.side}
            against={ours.against}
            slots={slots}
            rows={rows}
            states={states}
            lines={lines}
            listed={props.listed}
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
            withAdvice={false}
          />
        </>
      )}

      {ours && !states && <Reading>reading the scoreboard...</Reading>}

      {!ours && (
        <p class="hint">
          You have no game this week, so there is no lineup to set. Here is
          the whole week ranked instead.
        </p>
      )}

      {ours && (
        <p class="hint">
          <button onClick={() => setWholeWeek((on) => !on)}>
            {wholeWeek ? "hide the whole week" : "show the whole week"}
          </button>
        </p>
      )}

      {(!ours || wholeWeek) && (
        <WeekRanks
          slate={slate}
          rows={rows}
          roster={roster}
          listed={props.listed}
        />
      )}
    </>
  );
}
