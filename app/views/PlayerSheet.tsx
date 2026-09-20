/** Everything the board says about one player, on top of whatever view you were in. */

import { useEffect } from "preact/hooks";

import type { Pays, Player } from "../lib/scoring.ts";
import { payFor } from "../lib/scoring.ts";
import { asRound } from "../lib/picks.ts";
import { claimWords, reasonWords, roleWords } from "../lib/sleeperWords.ts";
import { movedForCatches, type SlateRow } from "../lib/slate.ts";
import { WeatherMark, weatherWords } from "./WeatherMark.tsx";
import { lineOver, movedBy } from "../lib/statLine.ts";

/** the week the slate covers, and his row on it if he has one */
export interface ThisWeek {
  week: number;
  row: SlateRow | undefined;
}

interface Props {
  p: Player;
  plus: string[];
  minus: string[];
  teams: number;
  pays?: Pays;
  /** what a catch paid when the board's weekly blends were scored */
  boardPerCatch?: number;
  thisWeek?: ThisWeek;
  onClose: () => void;
}

/** where a week's bar starts and ends, its box, and its middle */
interface WeekBands {
  pts: number;
  low: number;
  q1: number;
  q3: number;
  high: number;
}

type Week = NonNullable<Player["weeks"]>[number];

/**
 * One row per week, drawn as a box and whisker rather than a filled
 * bar. The season's per-game quantiles give the shape of a single week;
 * each week stretches that shape by its own matchup, so a soft one
 * shows a lower box and a shorter tail, not only a shorter bar.
 *
 * The week the slate covers takes the slate's own line instead, so the
 * card says the same number the matchup page starts him on. A later week
 * takes the board's blend of our line with Sleeper's, so week 3 and week
 * 9 are answering the same question as the week in front of you.
 */
function WeekByWeek(
  { p, pays, boardPerCatch, thisWeek }: {
    p: Player;
    pays: Pays;
    boardPerCatch?: number;
    thisWeek?: ThisWeek;
  },
) {
  const games = p.weeks ?? [];

  if (!games.length) {
    return null;
  }

  const g = p.game;
  const ev = g?.["ev"] ?? 0;
  const spread = g && ev > 0
    ? { low: g["low"]! / ev, q1: g["q1"]! / ev, q3: g["q3"]! / ev, high: g["high"]! / ev }
    : { low: 1, q1: 1, q3: 1, high: 1 };
  // The blend was scored once, at the build. A league paying a catch
  // differently moves it, the same way the slate moves, and a page with
  // no league connected leaves it where the board put it.
  const shift = pays["rec"] === undefined || boardPerCatch === undefined
    ? 0
    : pays["rec"] - boardPerCatch;
  const blendOf = (w: Week) => {
    if (w.blend === undefined) {
      return undefined;
    }

    return movedForCatches(w.blend, w.blend, w.catches ?? 0, shift);
  };
  // a week with no blend is a multiple of his own average, so the
  // league's own scoring is already in the number the card shows
  const bands = games.map((w): WeekBands => {
    const row = w.w === thisWeek?.week ? thisWeek.row : undefined;

    if (row) {
      return {
        pts: row.blend,
        low: row.floor,
        q1: row.q1 ?? row.blend * spread.q1,
        q3: row.q3 ?? row.blend * spread.q3,
        high: row.ceiling,
      };
    }

    const pts = blendOf(w) ?? w.of * (p.ppg ?? 0);

    return {
      pts,
      low: pts * spread.low,
      q1: pts * spread.q1,
      q3: pts * spread.q3,
      high: pts * spread.high,
    };
  });
  // what he actually scored, under this league's rules, in a week
  // already played; a week not yet played has nothing to score
  const played = games.map((w) => w.played ? payFor(w.played, pays) : null);
  const max = Math.max(
    ...bands.map((b) => b.high),
    ...played.filter((n): n is number => n !== null),
  ) || 1;
  const pct = (v: number) => (Math.max(0, v) / max) * 100;
  const weather = thisWeek?.row ? weatherWords(thisWeek.row) : undefined;

  return (
    <>
      <h2>week by week</h2>
      <div class="hint">
        Projection and usual range each week, with what he scored in a
        week already played.
      </div>
      {games.map((w, i) => {
        const { pts, low, q1, q3, high } = bands[i]!;
        const got = played[i] ?? null;
        const beat = got !== null ? got >= pts : null;

        return (
          <div class="wk" key={w.w}>
            <span>w{w.w}</span>
            <span>
              {w.opp}
              {w.w === thisWeek?.week && thisWeek.row && (
                <WeatherMark row={thisWeek.row} />
              )}
            </span>
            <span class="bar">
              <u style={{
                left: pct(low) + "%",
                right: (100 - pct(high)) + "%",
              }} />
              <i style={{
                left: pct(q1) + "%",
                right: (100 - pct(q3)) + "%",
              }} />
              <b style={{ left: pct(pts) + "%" }} />
              {got !== null && (
                <s class={beat ? "up" : "down"} style={{ left: pct(got) + "%" }} />
              )}
            </span>
            <span class="wkpts">
              {pts.toFixed(1)}
              <em>{low.toFixed(0)} to {high.toFixed(0)}</em>
            </span>
            {got !== null && (
              <span class="wkline">
                <b class={beat ? "up" : "down"}>{got.toFixed(1)}</b>
                <i>{beat ? "+" : ""}{(got - pts).toFixed(1)} vs projection</i>
              </span>
            )}
          </div>
        );
      })}
      <div class="wk">
        <span /><span />
        <div class="scale">
          <span>0</span><span>{(max / 2).toFixed(0)}</span><span>{max.toFixed(0)}</span>
        </div>
        <span />
      </div>
      {weather && (
        <div class="hint">Week {thisWeek!.week}: {weather}.</div>
      )}
    </>
  );
}

export function PlayerSheet(props: Props) {
  const { p, teams } = props;
  const g = p.game;
  const sim = p.sim;
  const said = p.sleeper;
  const why = said ? reasonWords(said) : "";
  const ifTheJobOpens = said ? roleWords(said) : "";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        props.onClose();
      }
    };

    window.addEventListener("keydown", onKey);

    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  return (
    <div id="overlay" class="open" onClick={props.onClose}>
      <div class="sheet" onClick={(e) => e.stopPropagation()}>
        <button class="close" aria-label="close" onClick={props.onClose}>
          ×
        </button>
        <h3>{p.name}</h3>
        <div class="sub">
          {p.position} &middot; {p.team ?? ""}
          {p.ppg !== undefined && (
            <>
              {" "}&middot; {p.ppg.toFixed(1)} a game
              {g && ` (median ${g["mid"]!.toFixed(1)}, eight weeks in ten ` +
                `${g["low"]!.toFixed(1)} to ${g["high"]!.toFixed(1)})`}
            </>
          )}
          {p.adp
            ? <>
                {" "}&middot; adp {asRound(p.adp, teams)}
                {p.adpLow && p.adpHigh &&
                  ` (${asRound(p.adpHigh, teams)} to ${asRound(p.adpLow, teams)})`}
              </>
            : " · undrafted"}
        </div>

        {said && (
          <div class="fact">
            against his price: <b>{claimWords(said)}</b> as of week{" "}
            {said.week}
            {why && `, on ${why}`}
          </div>
        )}

        {ifTheJobOpens && (
          <div class="fact">if the job opens: {ifTheJobOpens}</div>
        )}

        {p.games !== undefined && (
          <>
            <h2>season outlook, over {p.games.toFixed(1)} projected games</h2>
            <div class="statline big">
              {lineOver(p.projected ?? p.simulated, p.position, p.games, movedBy(p))
                .map((f) => (
                  <span class="s" key={f.label}>
                    <i>{f.label}</i>{f.value.toFixed(f.places)}
                  </span>
                ))}
            </div>
          </>
        )}

        {sim && (
          <>
            <h2>season total, 2000 simulations</h2>
            <div class="fact">expected <b>{sim["ev"]}</b> points, median <b>{sim["mid"]}</b></div>
            <div class="fact">eight seasons in ten between <b>{sim["low"]}</b> and <b>{sim["high"]}</b></div>
            <div class="fact">the middle half between <b>{sim["q1"]}</b> and <b>{sim["q3"]}</b></div>
            <div class="fact">about {sim.games} games played</div>
          </>
        )}

        {(props.plus.length > 0 || props.minus.length > 0) && (
          <>
            <h2>factors vs past years</h2>
            {props.plus.map((f) => <div class="fact p" key={f}>{f}</div>)}
            {props.minus.map((f) => <div class="fact m" key={f}>{f}</div>)}
          </>
        )}

        <WeekByWeek
          p={p}
          pays={props.pays ?? {}}
          boardPerCatch={props.boardPerCatch}
          thisWeek={props.thisWeek}
        />
      </div>
    </div>
  );
}
