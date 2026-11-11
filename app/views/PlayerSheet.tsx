/**
 * Everything the board says about one player, on top of whatever view
 * you were in, in the order a manager asks it: what he is worth this
 * week and on average, what he has done lately and how much he plays,
 * the weeks to come, his season, and why the model sees him that way.
 * Figures and small tables rather than sentences, and the long lists
 * open on a tap.
 */

import { useEffect, useRef, useState } from "preact/hooks";

import type { Pays, Player } from "../lib/scoring.ts";
import { payFor } from "../lib/scoring.ts";
import { asRound } from "../lib/picks.ts";
import { claimWords, reasonWords, roleWords } from "../lib/sleeperWords.ts";
import {
  catchShiftOf, movedForCatches, type SlateRow,
} from "../lib/slate.ts";
import { WeatherMark, weatherWords } from "./WeatherMark.tsx";
import { lineOver, movedBy } from "../lib/statLine.ts";
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

/** one week of his season: its line, and what he scored if it is played */
interface WeekRow {
  week: Week;
  band: WeekBands;
  got: number | null;
}

/** how many rows a list shows before it opens on a tap */
const SHOWN = 4;

/**
 * Every week of his season as the sheet reads it.
 *
 * The season's per-game quantiles give the shape of a single week, and
 * each week stretches that shape by its own matchup. The week the slate
 * covers takes the slate's own line instead, so the sheet says the same
 * number the matchup page starts him on. A later week takes the board's
 * blend of our line with Sleeper's, moved for what this league pays a
 * catch. A played week carries what he scored under the league's rules.
 */
function weekRowsOf(
  p: Player, pays: Pays, boardPerCatch?: number, thisWeek?: ThisWeek,
): WeekRow[] {
  const g = p.game;
  const ev = g?.["ev"] ?? 0;
  const spread = g && ev > 0
    ? { low: g["low"]! / ev, q1: g["q1"]! / ev, q3: g["q3"]! / ev, high: g["high"]! / ev }
    : { low: 1, q1: 1, q3: 1, high: 1 };
  const shift = catchShiftOf(pays, boardPerCatch);
  const blendOf = (w: Week) => w.blend === undefined
    ? undefined
    : movedForCatches(w.blend, w.blend, w.catches ?? 0, shift);

  return (p.weeks ?? []).map((week): WeekRow => {
    const row = week.w === thisWeek?.week ? thisWeek.row : undefined;
    const got = week.played ? payFor(week.played, pays) : null;

    if (row) {
      return {
        week,
        got,
        band: {
          pts: row.blend,
          low: row.floor,
          q1: row.q1 ?? row.blend * spread.q1,
          q3: row.q3 ?? row.blend * spread.q3,
          high: row.ceiling,
        },
      };
    }

    // a week with no blend is a multiple of his own average, so the
    // league's own scoring is already in the number
    const pts = blendOf(week) ?? week.of * (p.ppg ?? 0);

    return {
      week,
      got,
      band: {
        pts,
        low: pts * spread.low,
        q1: pts * spread.q1,
        q3: pts * spread.q3,
        high: pts * spread.high,
      },
    };
  });
}

/** a list's first rows, and a tap to open the rest */
function useOpening<T>(rows: T[]): { shown: T[]; more: number; toggle: () => void; open: boolean } {
  const [open, setOpen] = useState(false);

  return {
    shown: open ? rows : rows.slice(0, SHOWN),
    more: rows.length - SHOWN,
    toggle: () => setOpen((was) => !was),
    open,
  };
}

/**
 * The figures a manager looks for first: this week's line where the
 * slate has one, what he averages, and where the room drafts him.
 */
function KeyTiles(
  { p, teams, now, thisWeek }: {
    p: Player; teams: number; now: WeekRow | undefined; thisWeek?: ThisWeek;
  },
) {
  const weather = thisWeek?.row ? weatherWords(thisWeek.row) : undefined;

  return (
    <div class="tiles key">
      {/* a week of the season with no game for him is his bye */}
      {thisWeek && !now && (
        <div class="tile"><i>wk {thisWeek.week}</i><b>bye</b></div>
      )}
      {now && (
        <div class="tile">
          <i>wk {now.week.w} {now.week.opp}</i>
          <b>{now.band.pts.toFixed(1)}</b>
          <span>
            {now.band.low.toFixed(0)}–{now.band.high.toFixed(0)}
            {weather && <> · {weather}</>}
          </span>
        </div>
      )}
      {p.ppg !== undefined && (
        <div class="tile"><i>a game</i><b>{p.ppg.toFixed(1)}</b></div>
      )}
      <div class="tile">
        <i>adp</i>
        <b>{p.adp ? asRound(p.adp, teams) : "–"}</b>
        {p.adp && p.adpLow && p.adpHigh && (
          <span>{asRound(p.adpHigh, teams)}–{asRound(p.adpLow, teams)}</span>
        )}
      </div>
    </div>
  );
}

/**
 * The weeks he has played, newest first: what he scored against his
 * line, and how much he played, a column each. Points say what happened
 * and the work says whether it is likely to keep happening.
 */
function PlayedWeeks({ rows }: { rows: WeekRow[] }) {
  const newest = [...rows].reverse();
  const list = useOpening(newest);

  if (!rows.length) {
    return null;
  }

  return (
    <>
      <h2>played</h2>
      <table class="played">
        <thead>
          <tr>
            <th>wk</th><th /><th>pts</th><th>vs proj</th>
            <th>snaps</th><th>car</th><th>tgt</th>
          </tr>
        </thead>
        <tbody>
          {list.shown.map(({ week, band, got }) => {
            const over = (got ?? 0) - band.pts;
            const use = week.use;

            // a week gone by with nothing scored is one he missed
            if (got === null) {
              return (
                <tr key={week.w} class="missed">
                  <td>{week.w}</td>
                  <td class="opp">{week.opp}</td>
                  <td colSpan={5}>did not play</td>
                </tr>
              );
            }

            return (
              <tr key={week.w}>
                <td>{week.w}</td>
                <td class="opp">{week.opp}</td>
                <td class={"pts " + (over >= 0 ? "up" : "down")}>{got.toFixed(1)}</td>
                <td class="vs">{over >= 0 ? "+" : "−"}{Math.abs(over).toFixed(1)}</td>
                <td>{use ? `${use[0]}%` : "–"}</td>
                <td>{use ? use[1] : "–"}</td>
                <td>{use ? use[2] : "–"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {list.more > 0 && (
        <button class="textbtn more" onClick={list.toggle}>
          {list.open ? "fewer" : `all ${rows.length} weeks`}
        </button>
      )}
    </>
  );
}

/**
 * The weeks to come, a line each: the week, the opponent, his 80% and
 * 50% ranges as a bar with his line marked, and the line itself. The
 * next few show, and the rest of the season opens on a tap.
 */
function ComingWeeks({ rows, thisWeek }: { rows: WeekRow[]; thisWeek?: ThisWeek }) {
  const list = useOpening(rows);

  if (!rows.length) {
    return null;
  }

  const max = Math.max(...rows.map((r) => r.band.high)) || 1;
  const pct = (v: number) => (Math.max(0, v) / max) * 100;

  return (
    <>
      <h2>coming up</h2>
      {list.shown.map(({ week, band }) => (
        <div class="wk" key={week.w}>
          <span>w{week.w}</span>
          <span>
            {week.opp}
            {week.w === thisWeek?.week && thisWeek.row && (
              <WeatherMark row={thisWeek.row} />
            )}
          </span>
          <span class="bar" title={`${band.low.toFixed(0)}–${band.high.toFixed(0)}`}>
            <u style={{ left: pct(band.low) + "%", right: (100 - pct(band.high)) + "%" }} />
            <i style={{ left: pct(band.q1) + "%", right: (100 - pct(band.q3)) + "%" }} />
            <b style={{ left: pct(band.pts) + "%" }} />
          </span>
          <span class="wkpts">{band.pts.toFixed(1)}</span>
        </div>
      ))}
      <div class="wk">
        <span /><span />
        <div class="scale">
          <span>0</span><span>{(max / 2).toFixed(0)}</span><span>{max.toFixed(0)}</span>
        </div>
        <span />
      </div>
      <p class="pkey">
        <span><i class="kseg k-range" />80% range</span>
        <span><i class="kseg k-usual" />50% range</span>
        <span><i class="ktick" />proj</span>
      </p>
      {list.more > 0 && (
        <button class="textbtn more" onClick={list.toggle}>
          {list.open ? "fewer" : `rest of the season, ${list.more} more`}
        </button>
      )}
    </>
  );
}

/** one slot on the season strip: a week he played, missed, has to come, or his bye */
type Slot =
  | { w: number; kind: "bye" }
  | { w: number; kind: "played" | "missed" | "coming"; row: WeekRow };

/** the opponent as short as a column can hold: "NYG" at home, "@DAL" away */
const shortOpp = (opp: string) => opp.replace(/^v\s+/, "").replace(/^@\s+/, "@");

/**
 * His whole season as columns, a week each, wide enough to read: what he
 * scored on top of each played week, a bar of it green over his line or
 * amber under with the line across it; his line on top of each week to
 * come, over a box of his 50% range with its 80% whiskers; his bye and
 * his missed weeks where they fall. The weeks run sideways past the
 * sheet's edge, so the strip opens on this week with the last few played
 * to its left. This week is lit, and tapping a week says it in full
 * underneath.
 */
function SeasonStrip(
  { slots, now, picked, onPick }: {
    slots: Slot[]; now: number | null; picked: number | null;
    onPick: (w: number) => void;
  },
) {
  const strip = useRef<HTMLDivElement>(null);
  const tallest = Math.max(1, ...slots.flatMap((slot) => slot.kind === "bye" ? [] : [
    slot.row.got ?? 0, slot.kind === "coming" ? slot.row.band.high : slot.row.band.pts,
  ]));
  const at = (v: number) => (Math.max(0, v) / tallest) * 100 + "%";
  const span = (from: number, to: number) => ((Math.max(0, to) - Math.max(0, from)) / tallest) * 100 + "%";

  // open on this week, with the weeks just played to its left
  useEffect(() => {
    const box = strip.current;
    const lit = slots.findIndex((slot) => slot.w === now);

    if (box && lit >= 0) {
      const column = box.children[lit] as HTMLElement | undefined;

      box.scrollLeft = Math.max(0, (column?.offsetLeft ?? 0) - box.clientWidth * 0.62);
    }
  }, []);

  return (
    <div class="season-cols" ref={strip} role="list" aria-label="his season, a week to a column">
      {slots.map((slot) => {
        const classes = "scol " + slot.kind + (slot.w === now ? " now" : "") +
          (slot.w === picked ? " picked" : "");

        if (slot.kind === "bye") {
          return (
            <button key={slot.w} class={classes} role="listitem" onClick={() => onPick(slot.w)}>
              <span class="sval" />
              <span class="splot"><i class="sbye">bye</i></span>
              <span class="swk">{slot.w}</span>
              <span class="sopp">&nbsp;</span>
            </button>
          );
        }

        const { week, band, got } = slot.row;
        const beat = (got ?? 0) >= band.pts;

        return (
          <button key={slot.w} class={classes} role="listitem" onClick={() => onPick(slot.w)}>
            {slot.kind === "played" && (
              <span class={"sval " + (beat ? "up" : "down")}>{(got ?? 0).toFixed(1)}</span>
            )}
            {slot.kind === "coming" && <span class="sval proj">{band.pts.toFixed(1)}</span>}
            {slot.kind === "missed" && <span class="sval">–</span>}
            <span class="splot">
              {slot.kind === "played" && (
                <>
                  <i class={"sbar " + (beat ? "up" : "down")} style={{ height: at(got ?? 0) }} />
                  <i class="stick" style={{ bottom: at(band.pts) }} />
                </>
              )}
              {slot.kind === "coming" && (
                <>
                  <i class="swhisk" style={{ bottom: at(band.low), height: span(band.low, band.high) }} />
                  <i class="sbox" style={{ bottom: at(band.q1), height: span(band.q1, band.q3) }} />
                  <i class="stick" style={{ bottom: at(band.pts) }} />
                </>
              )}
              {slot.kind === "missed" && <i class="sout">out</i>}
            </span>
            <span class="swk">{slot.w}</span>
            <span class="sopp">{shortOpp(week.opp)}</span>
          </button>
        );
      })}
    </div>
  );
}

/** the week a tap picked, in full, under the strip */
function SlotSays({ slot }: { slot: Slot | undefined }) {
  if (!slot) {
    return null;
  }

  if (slot.kind === "bye") {
    return <p class="wsay"><b>wk {slot.w}</b> · bye</p>;
  }

  const { week, band, got } = slot.row;

  if (slot.kind === "missed") {
    return <p class="wsay"><b>wk {slot.w}</b> {week.opp} · did not play</p>;
  }

  if (slot.kind === "coming") {
    return (
      <p class="wsay">
        <b>wk {slot.w}</b> {week.opp} · proj <b>{band.pts.toFixed(1)}</b>
        {" "}· 80% range {band.low.toFixed(0)}–{band.high.toFixed(0)}
      </p>
    );
  }

  const over = (got ?? 0) - band.pts;
  const use = week.use;

  return (
    <p class="wsay">
      <b>wk {slot.w}</b> {week.opp} · <b class={over >= 0 ? "up" : "down"}>{(got ?? 0).toFixed(1)}</b>
      {" "}({over >= 0 ? "+" : "−"}{Math.abs(over).toFixed(1)} vs {band.pts.toFixed(1)})
      {use && <> · {use[0]}% snaps · {use[1]} car · {use[2]} tgt</>}
    </p>
  );
}

/** a label's position along the season bar, and how near two may sit */
const LABEL_ROOM = 14;

/**
 * His season over the simulations: what he is projected and the median
 * season, one bar with his 80% range across it, the 50% range darker
 * and the median marked, and the stat line his projection adds up to.
 * The numbers sit at the edges they belong to, and an inner one too
 * close to its neighbour is left off.
 */
function Season({ p }: { p: Player }) {
  const sim = p.sim;
  const line = p.games !== undefined
    ? lineOver(p.projected ?? p.simulated, p.position, p.games, movedBy(p))
    : [];

  if (!sim && !line.length) {
    return null;
  }

  return (
    <>
      <h2>season{p.games !== undefined ? ` · ${p.games.toFixed(1)} games` : ""}</h2>
      {sim && <SeasonRange sim={sim} />}
      {line.length > 0 && (
        <div class="statline big">
          {line.map((f) => (
            <span class="s" key={f.label}>
              <i>{f.label}</i>{f.value.toFixed(f.places)}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

function SeasonRange({ sim }: { sim: Record<string, number> }) {
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
      <div class="tiles season">
        <div class="tile"><i>proj</i><b>{Math.round(sim["ev"] ?? 0)}</b></div>
        <div class="tile"><i>median</i><b>{Math.round(mid)}</b></div>
      </div>
      <div class="srange" role="img"
        aria-label={`80% range ${low} to ${high}, 50% range ${q1} to ${q3}`}>
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
        <span><i class="kseg k-range" />80% range</span>
        <span><i class="kseg k-usual" />50% range</span>
        <span><i class="ktick" />median</span>
      </p>
    </>
  );
}

/**
 * Why the model sees him the way it does: what he projects against his
 * draft spot, what taking the job would do, and the factors against his
 * past years, each a line.
 */
function Why({ p, plus, minus }: { p: Player; plus: string[]; minus: string[] }) {
  const said = p.sleeper;
  const why = said ? reasonWords(said) : "";
  const ifTheJobOpens = said ? roleWords(said) : "";

  if (!said && !ifTheJobOpens && !plus.length && !minus.length) {
    return null;
  }

  return (
    <>
      <h2>why</h2>
      {said && (
        <div class="claim">
          <b>{claimWords(said)}</b>
          <span>wk {said.week}{why && ` · ${why}`}</span>
        </div>
      )}
      {ifTheJobOpens && <div class="fact">as the starter: {ifTheJobOpens}</div>}
      {plus.map((f) => <div class="fact p" key={f}>{f}</div>)}
      {minus.map((f) => <div class="fact m" key={f}>{f}</div>)}
    </>
  );
}

export function PlayerSheet(props: Props) {
  const { p, teams } = props;
  const [picked, setPicked] = useState<number | null>(null);
  const [every, setEvery] = useState(false);
  const rows = weekRowsOf(p, props.pays ?? {}, props.boardPerCatch, props.thisWeek);
  // a week before the one being played is behind him, scored or missed
  const gone = (r: WeekRow) =>
    r.got !== null || (props.thisWeek !== undefined && r.week.w < props.thisWeek.week);
  const played = rows.filter(gone);
  const coming = rows.filter((r) => !gone(r));
  // this week's line where the slate has one; on draft night there is none
  const now = props.thisWeek
    ? coming.find((r) => r.week.w === props.thisWeek!.week)
    : undefined;
  // every week of the season a slot, the bye where his schedule has no game
  const lastWeek = Math.max(0, ...rows.map((r) => r.week.w));
  const byWeek = new Map(rows.map((r) => [r.week.w, r]));
  const slots: Slot[] = Array.from({ length: lastWeek }, (_, i): Slot => {
    const w = i + 1;
    const row = byWeek.get(w);

    if (!row) {
      return { w, kind: "bye" };
    }

    return { w, kind: row.got !== null ? "played" : gone(row) ? "missed" : "coming", row };
  });
  const nowWeek = props.thisWeek?.week ?? null;
  const shownWeek = picked ?? nowWeek ??
    [...slots].reverse().find((slot) => slot.kind === "played")?.w ?? slots[0]?.w ?? null;

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
        <div class="sub">{p.position} &middot; {p.team ?? "no team"}</div>

        <KeyTiles p={p} teams={teams} now={now} thisWeek={props.thisWeek} />

        {slots.length > 0 && (
          <>
            <h2>his season</h2>
            <SeasonStrip slots={slots} now={nowWeek} picked={shownWeek} onPick={setPicked} />
            <SlotSays slot={slots.find((slot) => slot.w === shownWeek)} />
            <p class="pkey">
              <span><i class="kseg k-won" />beat proj</span>
              <span><i class="kseg k-under" />under</span>
              <span><i class="kseg k-box" />50% range</span>
              <span><i class="ktick k-ink" />proj</span>
            </p>
            <button class="fold" aria-expanded={every} onClick={() => setEvery((was) => !was)}>
              <h2>every week</h2>
            </button>
            {every && (
              <>
                <PlayedWeeks rows={played} />
                <ComingWeeks rows={coming} thisWeek={props.thisWeek} />
              </>
            )}
          </>
        )}
        <Season p={p} />
        <Why p={p} plus={props.plus} minus={props.minus} />
      </div>
    </div>
  );
}
