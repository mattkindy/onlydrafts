/**
 * One player, with what his big number measures written next to it.
 *
 * The views answer different questions, so they get different cards: a
 * week card is points in one game, a season card is points a game
 * across the year. A bare number with no unit is what let a draft score
 * and a weekly projection look identical on screen.
 */

import type { ComponentChildren } from "preact";
import type { Player } from "../lib/scoring.ts";
import { asRound, roundsOfGap, usuallyAt } from "../lib/picks.ts";
import type { Finish } from "../lib/finish.ts";
import { STREAMED } from "../lib/replacementPool.ts";
import { lineOver, movedBy } from "../lib/statLine.ts";

export interface Range {
  low: number;
  mid: number;
  high: number;
  tailLow?: number;
  tailHigh?: number;
}

export interface CardProps {
  p: Player;
  value: number;
  unit: string;
  max: number;
  range?: Range;
  aside?: { label: string; value: string };
  note?: ComponentChildren;
  tag?: string;
  warn?: boolean;
  badge?: string;
  badgeHow?: string;
  /** spelled out on hover, since a badge has room for one word */
  badgeTitle?: string;
  /** the number the list is ordered by, which leads the card */
  leadPick?: { label: string; value: string };
  /** and the other way of counting him, small underneath */
  thenPick?: { label: string; value: string };
  /** draws the room's range against ours in place of the points spread */
  teamsInLeague?: number;
  /** where his season could place him at his position */
  finish?: Finish | null;
  mine?: boolean;
  kept?: boolean;
  gone?: boolean;
  onMore?: () => void;
  children?: ComponentChildren;
}

/** one scale for every season card on screen, so the bars compare */
export const seasonScale = (men: Player[]) =>
  Math.max(12, ...men.map((p) => (p.game?.["high"] ?? p.ppg) ?? 0)) * 1.02;

export function ordinal(n: number) {
  if (n % 100 >= 11 && n % 100 <= 13) {
    return n + "th";
  }

  return n + (["th", "st", "nd", "rd"][n % 10] ?? "th");
}

/**
 * Where the room takes him against where we have him, both on a scale
 * of picks. The one thing a drafter wants at his turn is whether the
 * man will still be there next time, and that is the room's range and
 * not his points.
 *
 * The window is this man's own, not the board's, because a bar scaled
 * to fifteen rounds shows nothing about a first-rounder.
 */
function OnTheBoard(
  { p, teams }: { p: Player; teams: number },
) {
  if (!p.adp || !p.rank) {
    return null;
  }

  const early = p.adpHigh ?? p.adp;
  const late = p.adpLow ?? p.adp;
  const from = Math.max(1, Math.min(early, p.rank) - 6);
  const to = Math.max(late, p.rank) + 6;
  const span = (v: number) =>
    Math.max(0, Math.min(100, ((v - from) / (to - from)) * 100));

  return (
    <div class="board">
      <div class="track" title={`the room takes him between ${asRound(early, teams)} and ${asRound(late, teams)}`}>
        <span
          class="room"
          style={{
            left: span(early) + "%", width: (span(late) - span(early)) + "%",
          }}
        />
        <span class="at" style={{ left: span(p.adp) + "%" }} />
        <span class="ours" style={{ left: span(p.rank) + "%" }} />
      </div>
      <div class="rangenum">
        <span>{asRound(from, teams)}</span>
        <span>{asRound(to, teams)}</span>
      </div>
    </div>
  );
}

/** how he could finish at his own position, which is how people think */
function Finishes({ finish }: { finish: Finish }) {
  return (
    <div class="finish" title="where his season would place him at his position, holding everyone else at their expected season">
      <span class="over">could finish</span>
      <span class="s">{finish.best}</span>
      <span class="to">to</span>
      <span class="s">{finish.worst}</span>
      <span class="mid">usually {finish.mid}</span>
    </div>
  );
}

function Spread({ range, max }: { range: Range; max: number }) {
  const span = (v: number) => Math.max(0, Math.min(100, (v / max) * 100));
  const { tailLow, tailHigh } = range;

  return (
    <>
      {/* The middle half sits inside the tenth to ninetieth, because on
          its own it reads as a steady player: it covers 0.72 of a man's
          own average where his weeks actually run 1.27 across. */}
      <div class="range">
        {tailLow !== undefined && tailHigh !== undefined && (
          <span
            class="tail"
            style={{
              left: span(tailLow) + "%",
              width: (span(tailHigh) - span(tailLow)) + "%",
            }}
          />
        )}
        <span
          class="span"
          style={{
            left: span(range.low) + "%",
            width: (span(range.high) - span(range.low)) + "%",
          }}
        />
        <span class="mark" style={{ left: span(range.mid) + "%" }} />
      </div>
      <div class="rangenum">
        <span>{(tailLow ?? range.low).toFixed(1)}</span>
        <span>{(tailHigh ?? range.high).toFixed(1)}</span>
      </div>
    </>
  );
}

export function Card(props: CardProps) {
  const { p, range, aside, onMore } = props;
  const classes = ["card", props.mine && "mine", props.kept && "kept",
    props.gone && "gone"].filter(Boolean).join(" ");

  return (
    <div class={classes}>
      <div class="top">
        <span class="nm">
          <span class="who">{p.name}</span>
          {props.badge && (
            <span
              class={"badge " + (props.badgeHow ?? "")}
              title={props.badgeTitle}
            >
              {props.badge}
            </span>
          )}
          {/* Opening the detail belongs on its own control. The whole
              card used to take the click, so typing a keeper price
              opened the overlay on top of the input. */}
          {onMore && (
            <button
              class="more"
              title="more about him"
              aria-label="more"
              onClick={(e) => { e.stopPropagation(); onMore(); }}
            >
              <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
                <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.6" />
                <path d="M10 9v5M10 6.2v.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
              </svg>
            </button>
          )}
        </span>
        {/* The pick leads, because the list is ordered by it and a
            reader looking down the page is reading picks. The other
            way of counting him goes underneath, small. */}
        {props.leadPick ? (
          <span class="big">
            {props.leadPick.value}
            <em class="unit">{props.leadPick.label}</em>
            {props.thenPick && (
              <em class="then">
                {props.thenPick.label} {props.thenPick.value}
              </em>
            )}
          </span>
        ) : (
          <span class="big">
            {props.value.toFixed(1)}
            <em class="unit">{props.unit}</em>
          </span>
        )}
      </div>
      <div class="sub">
        <span>{p.position} &middot; {p.team ?? ""}</span>
      </div>
      {props.teamsInLeague
        ? <OnTheBoard p={p} teams={props.teamsInLeague} />
        : range && <Spread range={range} max={props.max} />}
      {props.finish && <Finishes finish={props.finish} />}
      {props.note && <div class="note">{props.note}</div>}
      {props.tag && (
        <div class={"tag" + (props.warn ? " warn" : "")}>{props.tag}</div>
      )}
      {props.children}
    </div>
  );
}

/**
 * The few figures that put the big number in context: where we have
 * him, where the room has him, how many games he plays, and his bye.
 */
function Facts({ p, teams, costs, aside }: {
  p: Player; teams: number; costs?: number | null;
  aside?: { label: string; value: string };
}) {
  const rounds = roundsOfGap(p, teams);

  return (
    <span class="facts">
      {/* Where he is taken moved to the top of the card and the bar
          under it, so what is left here is what he does. */}
      <span class="f">
        <i>pts/g</i>{(p.game?.["ev"] ?? p.ppg ?? 0).toFixed(1)}
      </span>
      {aside && <span class="f"><i>{aside.label}</i>{aside.value}</span>}
      {/* what he beats the last starter by, over the middle ninety of
          his seasons, since the same average can be two different bets */}
      {p.par && (
        <span
          class="f"
          title="what he beats the last man your league starts by over a season, from the tenth to the ninetieth of the seasons played out for him. The middle figure is the median, which he beats half the time."
        >
          <i>over a season</i>
          {p.par.low.toFixed(0)} to {p.par.high.toFixed(0)}
          <small>usually {p.par.mid.toFixed(0)}</small>
        </span>
      )}
      {costs ? <span class="f"><i>costs</i>{ordinal(costs)}</span> : null}
      {rounds !== 0 && (
        <span class={"chip " + (rounds > 0 ? "up" : "down")}>
          {rounds > 0 ? "+" : ""}{rounds} rd
        </span>
      )}
      {/* what reconciles the rate with the season value beside it: a
          man who plays more games is worth more at the same rate */}
      {p.games !== undefined && (
        <span
          class="f"
          title="games we expect him to play, from his injury history, his age and his workload"
        >
          <i>games</i>{p.games.toFixed(1)}
        </span>
      )}
      {/* The big value is what a pick at his place on the board is
          worth. This is what his own projection says he is worth, shown
          when the two disagree, which is when the room and the model
          disagree about him. */}
      {/* a kicker and a defence lead with this number already, so
          printing it again here says the same thing twice */}
      {!STREAMED.has(p.position) &&
        p.ownVor !== undefined && p.vor !== undefined &&
        Math.abs(p.ownVor - p.vor) >= 10 && (
        <span
          class="f"
          title="what his own projection says he is worth over a season, before the room and the touches and the walk are mixed in. The bigger number is what a pick at his place on the board is worth."
        >
          <i>ours alone</i>{p.ownVor.toFixed(0)}
        </span>
      )}
      {p.bye ? <span class="f"><i>bye</i>{p.bye}</span> : null}
    </span>
  );
}

/**
 * What he does, in the categories a box score uses. Both rows are here
 * because they answer different questions: a season is what anybody
 * weighing two men wants, and a game is what you check the season
 * against when it looks too big.
 */
function StatLine({ p }: { p: Player }) {
  // the walk's line leads, since the walk is the model the board
  // trusts most; the regression speaks only for men it never saw
  const parts = p.simulated ?? p.projected;
  const moved = movedBy(p);
  const season = lineOver(parts, p.position, p.games ?? 17, moved);
  const game = lineOver(parts, p.position, 1, moved);

  if (!season.length) {
    return null;
  }

  /**
   * A table rather than two rows of chips. The same categories run down
   * both rows, so the label was being repeated on every one of them and
   * a card carried a dozen pills saying the same six words twice.
   */
  return (
    <table class="line">
      <thead>
        <tr>
          <th></th>
          {season.map((f) => <th key={f.label}>{f.label}</th>)}
        </tr>
      </thead>
      <tbody>
        <tr>
          <th>season</th>
          {season.map((f) => <td key={f.label}>{f.value.toFixed(0)}</td>)}
        </tr>
        <tr>
          <th>a game</th>
          {game.map((f) => <td key={f.label}>{f.value.toFixed(1)}</td>)}
        </tr>
      </tbody>
    </table>
  );
}

/** the season: what he scores in a typical game, and how those vary */
export function SeasonCard(
  props: Omit<CardProps, "value" | "unit" | "range" | "note"> & {
    teams: number;
    costs?: number | null;
    /** which way of counting him the list is ordered by */
    lead?: "rank" | "adp";
  },
) {
  const { p, teams } = props;
  const g = p.game;
  const ours = p.rank ? asRound(p.rank, teams) : null;
  const room = p.adpRank ? asRound(p.adpRank, teams) : null;
  const leading = props.lead === "adp" ? room : ours;
  const then = props.lead === "adp" ? ours : room;

  return (
    <Card
      {...props}
      value={g?.["ev"] ?? p.ppg ?? 0}
      unit="pts/g"
      leadPick={leading
        ? { label: props.lead === "adp" ? "adp" : "ours", value: leading }
        : undefined}
      thenPick={then
        ? { label: props.lead === "adp" ? "ours" : "adp", value: then }
        : undefined}
      range={g
        ? {
            low: g["q1"]!, mid: g["ev"]!, high: g["q3"]!,
            tailLow: g["low"], tailHigh: g["high"],
          }
        : undefined}
      note={
        <>
          <StatLine p={p} />
          <Facts p={p} teams={teams} costs={props.costs} aside={props.aside} />
        </>
      }
    />
  );
}
