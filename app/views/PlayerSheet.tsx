/** Everything the board says about one player, on top of whatever view you were in. */

import type { Pays, Player } from "../lib/scoring.ts";
import { payFor } from "../lib/scoring.ts";
import { asRound } from "../lib/picks.ts";
import { claimWords, reasonWords, roleWords } from "../lib/sleeperWords.ts";
import {
  catchShiftOf, movedForCatches, type SlateRow,
} from "../lib/slate.ts";
import { WeatherMark, weatherWords } from "./WeatherMark.tsx";
import { lineOver, movedBy } from "../lib/statLine.ts";
import { workOf, type Work } from "../lib/usage.ts";
import { useSheet } from "./useSheet.ts";

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
  // differently moves it, the same way the slate moves.
  const shift = catchShiftOf(pays, boardPerCatch);
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
      <p class="pkey">
        <span><i class="kseg k-range" />range</span>
        <span><i class="kseg k-usual" />usual</span>
        <span><i class="ktick" />proj</span>
        <span><i class="kdot" /><i class="kdot down" />scored, over or under</span>
      </p>
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
                {w.use && <i>{useWords(w.use)}</i>}
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

/** one week's work, short enough to sit under his points */
const useWords = (use: NonNullable<Week["use"]>) =>
  `${use[0]}% snaps, ${use[1]} car, ${use[2]} tgt` +
  (use[3] > 0 ? `, ${use[3]} in the 20` : "");

/** a stretch of his work as a sentence */
const workLine = (work: Work) =>
  `${Math.round(work.snaps)}% of the snaps, ${work.carries.toFixed(1)} ` +
  `carries, ${work.targets.toFixed(1)} targets, ${work.redZone.toFixed(1)} ` +
  "inside the 20";

/**
 * His work, the last few games against the ones before. Points say what
 * happened and this says whether it is likely to keep happening.
 */
function HisWork({ p }: { p: Player }) {
  const work = workOf(p);

  if (!work) {
    return null;
  }

  return (
    <>
      <h2>his work</h2>
      <div class="fact">
        last {work.recent.games === 1 ? "game" : `${work.recent.games} games`}:{" "}
        {workLine(work.recent)}
      </div>
      {work.before && (
        <div class="fact">
          {work.before.games === 1 ? "the game" : `the ${work.before.games} games`}
          {" "}before: {workLine(work.before)}
        </div>
      )}
    </>
  );
}

/** a label's position along the season bar, and how near two may sit */
const LABEL_ROOM = 14;

/**
 * His season over the simulations, as figures and one bar rather than
 * sentences: what he is projected, the median season and the games he
 * plays, then where eight seasons in ten land with the middle half
 * darker and the median marked. The numbers sit at the edges they
 * belong to, and an inner one too close to its neighbour is left off.
 */
function SeasonTotal({ sim }: { sim: Record<string, number> & { games?: number } }) {
  const low = sim["low"] ?? 0;
  const q1 = sim["q1"] ?? 0;
  const mid = sim["mid"] ?? 0;
  const q3 = sim["q3"] ?? 0;
  const high = sim["high"] ?? 0;
  const top = Math.max(high, 1);
  const at = (v: number) => (Math.max(0, v) / top) * 100;
  const roomy = (a: number, b: number) => Math.abs(at(a) - at(b)) >= LABEL_ROOM;

  return (
    <>
      <h2>season total</h2>
      <div class="tiles season">
        <div class="tile"><i>proj</i><b>{Math.round(sim["ev"] ?? 0)}</b></div>
        <div class="tile"><i>median</i><b>{Math.round(mid)}</b></div>
        {sim.games !== undefined && (
          <div class="tile"><i>games</i><b>{sim.games.toFixed(1)}</b></div>
        )}
      </div>
      <div class="srange" role="img"
        aria-label={`eight seasons in ten between ${low} and ${high}, the middle half ${q1} to ${q3}`}>
        <span class="bar">
          <u style={{ left: at(low) + "%", right: (100 - at(high)) + "%" }} />
          <i style={{ left: at(q1) + "%", right: (100 - at(q3)) + "%" }} />
          <b style={{ left: at(mid) + "%" }} />
        </span>
        <span class="ends" aria-hidden="true">
          <span class="lo" style={{ left: at(low) + "%" }}>{Math.round(low)}</span>
          {roomy(q1, low) && roomy(q1, q3) && (
            <span class="in" style={{ left: at(q1) + "%" }}>{Math.round(q1)}</span>
          )}
          {roomy(q3, high) && roomy(q1, q3) && (
            <span class="in" style={{ left: at(q3) + "%" }}>{Math.round(q3)}</span>
          )}
          <span class="hi" style={{ right: (100 - at(high)) + "%" }}>{Math.round(high)}</span>
        </span>
      </div>
      <p class="pkey">
        <span><i class="kseg k-range" />8 in 10 seasons</span>
        <span><i class="kseg k-usual" />middle half</span>
        <span><i class="ktick" />median</span>
      </p>
    </>
  );
}

export function PlayerSheet(props: Props) {
  const { p, teams } = props;
  const sim = p.sim;
  const said = p.sleeper;
  const why = said ? reasonWords(said) : "";
  const ifTheJobOpens = said ? roleWords(said) : "";

  const sheet = useSheet(props.onClose);

  return (
    <div id="overlay" class="open" onClick={props.onClose}>
      <div
        class="sheet" ref={sheet} role="dialog" aria-modal="true"
        aria-label={p.name} onClick={(e) => e.stopPropagation()}
      >
        <button class="close" aria-label="close" onClick={props.onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
        <h3>{p.name}</h3>
        <div class="sub">
          {p.position} &middot; {p.team ?? ""}
          {p.ppg !== undefined && <>{" "}&middot; {p.ppg.toFixed(1)} a game</>}
          {p.adp
            ? <>
                {" "}&middot; adp {asRound(p.adp, teams)}
                {p.adpLow && p.adpHigh &&
                  ` (${asRound(p.adpHigh, teams)}–${asRound(p.adpLow, teams)})`}
              </>
            : " · undrafted"}
        </div>

        {said && (
          <div class="fact">
            sleeper score: <b>{claimWords(said)}</b> as of week{" "}
            {said.week}
            {why && `, from ${why}`}
          </div>
        )}

        {ifTheJobOpens && (
          <div class="fact">as the starter: {ifTheJobOpens}</div>
        )}

        {p.games !== undefined && (
          <>
            <h2>season outlook · {p.games.toFixed(1)} games</h2>
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

        {sim && <SeasonTotal sim={sim} />}

        {(props.plus.length > 0 || props.minus.length > 0) && (
          <>
            <h2>factors vs past years</h2>
            {props.plus.map((f) => <div class="fact p" key={f}>{f}</div>)}
            {props.minus.map((f) => <div class="fact m" key={f}>{f}</div>)}
          </>
        )}

        <HisWork p={p} />

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
