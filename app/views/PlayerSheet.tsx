/** Everything the board says about one man, on top of whatever view you were in. */

import type { Player } from "../lib/scoring.ts";
import { asRound } from "../lib/picks.ts";
import { lineOver, movedBy } from "../lib/statLine.ts";

interface Props {
  p: Player;
  plus: string[];
  minus: string[];
  teams: number;
  kept: boolean;
  onKeep: () => void;
  onClose: () => void;
}

/**
 * One row per week, drawn as a box and whisker rather than a filled
 * bar. The season's per-game quantiles give the shape of a single week;
 * each week stretches that shape by its own matchup, so a soft one
 * shows a lower box and a shorter tail, not only a shorter bar.
 */
function WeekByWeek({ p }: { p: Player }) {
  const games = p.weeks ?? [];

  if (!games.length) {
    return null;
  }

  const g = p.game;
  const ev = g?.["ev"] ?? 0;
  const spread = g && ev > 0
    ? { low: g["low"]! / ev, q1: g["q1"]! / ev, q3: g["q3"]! / ev, high: g["high"]! / ev }
    : { low: 1, q1: 1, q3: 1, high: 1 };
  // a week is a multiple of his own average, so the league's own
  // scoring is already in the number the card shows
  const points = games.map((w) => w.of * (p.ppg ?? 0));
  const max = Math.max(...points.map((n) => n * spread.high)) || 1;
  const pct = (v: number) => (v / max) * 100;

  return (
    <>
      <h2>week by week</h2>
      <div class="hint">
        The big number is what he averages that week and it barely
        moves, because a defence keeps 0.073 of one season into the
        next and in August week nine cannot be told from week three.
        The pair under it is where he lands eight weeks in ten, and
        that is the swing worth looking at: it is most of his range,
        every week, and which week is which is not knowable yet.
      </div>
      {games.map((w, i) => {
        const pts = points[i]!;

        return (
          <div class="wk" key={w.w}>
            <span>w{w.w}</span>
            <span>{w.opp}</span>
            <span class="bar">
              <u style={{
                left: pct(pts * spread.low) + "%",
                right: (100 - pct(pts * spread.high)) + "%",
              }} />
              <i style={{
                left: pct(pts * spread.q1) + "%",
                right: (100 - pct(pts * spread.q3)) + "%",
              }} />
              <b style={{ left: pct(pts) + "%" }} />
            </span>
            <span class="wkpts">
              {pts.toFixed(1)}
              <em>{(pts * spread.low).toFixed(0)} to {(pts * spread.high).toFixed(0)}</em>
            </span>
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
    </>
  );
}

export function PlayerSheet(props: Props) {
  const { p, teams } = props;
  const g = p.game;
  const sim = p.sim;

  return (
    <div id="overlay" class="open" onClick={props.onClose}>
      <div class="sheet" onClick={(e) => e.stopPropagation()}>
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

        {p.games !== undefined && (
          <>
            <h2>a season of him, over {p.games.toFixed(1)} games</h2>
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

        <WeekByWeek p={p} />

        <div class="row">
          <button class="act" onClick={props.onKeep}>
            {props.kept ? "unmark keeper" : "mark as keeper"}
          </button>
          <button
            class="act"
            style={{ background: "var(--chip)", color: "var(--ink)" }}
            onClick={props.onClose}
          >
            close
          </button>
        </div>
      </div>
    </div>
  );
}
