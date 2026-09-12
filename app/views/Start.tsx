/**
 * Your own lineup, seat by seat, with who else could take each one.
 *
 * Every alternative is priced the way the matchup card prices a swap:
 * how often you beat this week's opponent if he starts there instead of
 * the man who is in the seat. The two tabs run the same machinery on the
 * same draws, so the numbers on them agree.
 *
 * A man whose game has kicked off is still shown, marked locked, because
 * knowing you missed him is worth more than hiding him.
 */

import { useEffect, useMemo, useState } from "preact/hooks";

import { leadFor, type Explanation } from "../lib/explain.ts";
import {
  alternativesFor, gameStates, lineFor, starterState,
  type GameState, type Lines, type SlotChoice,
} from "../lib/matchups.ts";
import type { Matchup, Side } from "../lib/providers.ts";
import type { Player } from "../lib/scoring.ts";
import type { Slate, SlateRow, WeekRef } from "../lib/slate.ts";
import { Advice, nameOf } from "./Advice.tsx";
import { ManName } from "./ManName.tsx";
import { WeekRanks } from "./WeekRanks.tsx";

interface Props {
  weeks: WeekRef[];
  picked: WeekRef | null;
  onWeek: (w: WeekRef) => void;
  slate: Slate | null;
  /** the men on your team, or nothing when no league is connected */
  roster: Set<string> | null;
  /** this week's games in your league, for the one you are in */
  games: Matchup[];
  rows: Map<string, SlateRow>;
  /** the board in this league's terms, for the men the slate leaves out */
  men: Player[];
  /** your own team's name in the league */
  mine: string | null;
  slots: string[] | null;
  status?: string;
}

const signed = (gains: number) =>
  (gains > 0 ? "+" : "") + (100 * gains).toFixed(1) + "%";

/** what a man is worth this week, as the seat headings and options read it */
function Numbers(
  { line, left }: {
    line: ReturnType<typeof lineFor>;
    /** how much of his game is still to play */
    left: number;
  },
) {
  if (!line) {
    return <span class="seat-fig">no line</span>;
  }

  return (
    <span class="seat-fig">
      <b>{(line.blend * left).toFixed(1)}</b> proj{" "}
      <i>
        {line.spread.low.toFixed(1)} to {line.spread.high.toFixed(1)}
      </i>
      {line.stock && <i> stock</i>}
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
    ["spread", why.spread],
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
  { choice, rows, states, lines }: {
    choice: SlotChoice;
    rows: Map<string, SlateRow>;
    states: Map<string, GameState>;
    lines: Lines;
  },
) {
  const at = (key: string, slot?: string) => {
    const line = lineFor({ key, slot }, rows, lines);
    const state = starterState({ key, slot }, rows, states, lines);

    return { line, left: state?.left ?? 1 };
  };
  const his = at(choice.starter.key, choice.slot);

  return (
    <section class="seat-card">
      <h3>
        <span class="chip">{choice.slot}</span>
        <ManName
          name={nameOf(choice.starter.key, rows, lines)}
          team={his.line?.team}
        />
        <span class="now">{choice.starter.points.toFixed(1)}</span>
        <Numbers line={his.line} left={his.left} />
        {choice.locked && <span class="badge even">locked</span>}
      </h3>

      {choice.options.length === 0
        ? <p class="hint">Nobody on the bench can take this seat.</p>
        : (
          <ul class="options">
            {choice.options.map((option) => {
              const other = at(option.key);

              return (
                <li key={option.key} class={option.locked ? "shut" : ""}>
                  <ManName
                    name={nameOf(option.key, rows, lines)}
                    team={other.line?.team}
                  />
                  <Numbers line={other.line} left={other.left} />
                  <span class={"delta" + (option.gains > 0 ? " up" : "")}>
                    {signed(option.gains)}
                  </span>
                  {option.locked && <span class="badge even">locked</span>}
                  {option.why && <Why why={option.why} />}
                </li>
              );
            })}
          </ul>
        )}
    </section>
  );
}

/** your side of this week's game, and the side across from it */
function myGame(games: Matchup[], mine: string | null) {
  for (const game of games) {
    const at = game.sides.findIndex((s) => s.owner === mine);

    if (at >= 0) {
      return { side: game.sides[at]!, against: game.sides[1 - at]! };
    }
  }

  return null;
}

function Lineup(
  { side, against, slots, rows, states, lines }: {
    side: Side;
    against: Side;
    slots: string[] | null;
    rows: Map<string, SlateRow>;
    states: Map<string, GameState>;
    lines: Lines;
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
        />
      ))}
    </>
  );
}

export function Start(props: Props) {
  const { games, mine, rows, slots, slate, roster } = props;
  const [states, setStates] = useState<Map<string, GameState> | null>(null);
  const [trouble, setTrouble] = useState("");
  const [wholeWeek, setWholeWeek] = useState(false);
  const season = props.picked?.season;
  const week = props.picked?.week;

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

  const lines = useMemo(
    () => new Map(props.men.map((p) => [p.key, p])), [props.men]);
  const ours = useMemo(() => myGame(games, mine), [games, mine]);

  if (!props.weeks.length) {
    return (
      <div class="empty">
        <b>No week has been built yet.</b> Weekly projections need a few
        games of this year's snaps and targets, so they turn on about a
        month in. Until then use <b>draft help</b> and <b>my roster</b>.
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
            Against {ours.against.owner} this week. Each man is priced by
            what starting him in that seat does to your chance of winning.
          </p>
          <Lineup
            side={ours.side}
            against={ours.against}
            slots={slots}
            rows={rows}
            states={states}
            lines={lines}
          />
        </>
      )}

      {ours && !states && <div class="empty">reading the scoreboard...</div>}

      {!ours && (
        <p class="hint">
          You have no game to set a lineup against this week, so here is
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

      {(!ours || wholeWeek) && <WeekRanks slate={slate} roster={roster} />}
    </>
  );
}
