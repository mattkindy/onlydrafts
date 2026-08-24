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
            <span class={"badge " + (props.badgeHow ?? "")}>{props.badge}</span>
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
        <span class="big">
          {props.value.toFixed(1)}
          <em class="unit">{props.unit}</em>
        </span>
      </div>
      <div class="sub">
        <span>{p.position} &middot; {p.team ?? ""}</span>
        {aside && <span class="val">{aside.label} {aside.value}</span>}
      </div>
      {range && <Spread range={range} max={props.max} />}
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
function Facts({ p, teams, costs }: {
  p: Player; teams: number; costs?: number | null;
}) {
  const rounds = roundsOfGap(p, teams);
  const ownPpg = p.ownPpg;
  const shown = p.ppg ?? 0;

  return (
    <span class="facts">
      {/* no raw number beside ours: a rank is a whole pick, so the round
          and the pick would say the same thing twice */}
      {p.rank ? <span class="f"><i>ours</i>{asRound(p.rank, teams)}</span> : null}
      <span
        class="f"
        title={p.adp
          ? `pick ${p.adp.toFixed(1)} overall on average. The two picks ` +
            "after it are where he is still on the board three times in " +
            "four, and where he is gone three times in four"
          : undefined}
      >
        <i>adp</i>{p.adpRank ? asRound(p.adpRank, teams) : "—"}
        {/* the spread the room has shown, since a place alone says
            nothing about how firmly it is held */}
        {p.adp ? <small>{usuallyAt(p)}</small> : null}
      </span>
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
      {ownPpg !== undefined && Math.abs(ownPpg - shown) >= 1.5 && (
        <span
          class="f"
          title="what our own projection says, before the market and the share model are mixed in"
        >
          <i>ours alone</i>{ownPpg.toFixed(1)}
        </span>
      )}
      {p.bye ? <span class="f"><i>bye</i>{p.bye}</span> : null}
    </span>
  );
}

/**
 * What he does over a season, in the categories a box score uses. A
 * game's worth of it was too easy to read as a week, and a season is
 * the number anybody weighing two men wants anyway.
 */
function StatLine({ p }: { p: Player }) {
  const line = lineOver(p.projected ?? p.simulated, p.position, p.games ?? 17,
    movedBy(p));

  if (!line.length) {
    return null;
  }

  return (
    <div class="statline">
      <span class="over">season</span>
      {line.map((f) => (
        <span class="s" key={f.label}>
          <i>{f.label}</i>{f.value.toFixed(0)}
        </span>
      ))}
    </div>
  );
}

/** the season: what he scores in a typical game, and how those vary */
export function SeasonCard(
  props: Omit<CardProps, "value" | "unit" | "range" | "note"> & {
    teams: number;
    costs?: number | null;
  },
) {
  const g = props.p.game;

  return (
    <Card
      {...props}
      value={g?.["ev"] ?? props.p.ppg ?? 0}
      unit="pts/g"
      range={g
        ? {
            low: g["q1"]!, mid: g["ev"]!, high: g["q3"]!,
            tailLow: g["low"], tailHigh: g["high"],
          }
        : undefined}
      note={
        <>
          <StatLine p={props.p} />
          <Facts p={props.p} teams={props.teams} costs={props.costs} />
        </>
      }
    />
  );
}
