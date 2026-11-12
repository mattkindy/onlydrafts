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
import { useMemo, useState } from "preact/hooks";

import type { Listed } from "../lib/availability.ts";
import {
  bestLineupFor, lineFor, linesFor, myGameIn, settledGames, standingFor,
  starterState, type GameState, type Lines,
} from "../lib/matchups.ts";
import type { League, Matchup, Roster, Side } from "../lib/providers.ts";
import { scoredSays, type Pays, type Player } from "../lib/scoring.ts";
import {
  catchShiftOf, hurtWord, type Slate, type SlateRow, type WeekRef,
} from "../lib/slate.ts";
import { WeatherMark } from "./WeatherMark.tsx";
import { WeekPicker } from "./WeekPicker.tsx";
import { gainPct, nameOf, pct, WORTH_A_MOVE } from "./Advice.tsx";
import { injuryBadge, WORRYING } from "./Draft.tsx";
import { PlayerName } from "./PlayerName.tsx";
import { Game } from "./Matchups.tsx";
import { Reading, Skeleton } from "./Reading.tsx";
import { useLiveWeek, type WeekPoll } from "./scoreboard.ts";
import { GoLink } from "./GoLink.tsx";
import { lineupLink, playersLink, PROVIDER_NAME } from "../lib/deepLinks.ts";
import { standingSays } from "./Standings.tsx";

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
  /** every team in the league, for the records over the scoreline */
  teams?: Roster[];
  /** takes you to the free agents at a position, to fill a hole */
  onFind?: (position: string) => void;
  /** the league itself, for the links out to the provider's own pages */
  leagueOf?: League | null;
}

/** one figure with what it measures over it, so no number is bare */
function Fig(
  { label, col, children }: {
    label: string;
    /** which column the figure stands in when a lineup is laid out as rows */
    col?: string;
    children: ComponentChildren;
  },
) {
  return (
    <span class={col ? `fig c-${col}` : "fig"}>
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
      <Fig label="proj" col="proj">
        {line.blend.toFixed(1)}
        {line.stock ? <small> stock</small> : null}
      </Fig>
      {left > 0 && left < 1 && (
        <Fig label="still to come" col="left">{(line.blend * left).toFixed(1)}</Fig>
      )}
      <Fig label="floor to ceiling" col="range">
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

/** a player's line for the week and how much of his game is left to play */
function lineAndLeft(
  key: string, slot: string | undefined, rows: Map<string, SlateRow>,
  states: Map<string, GameState>, lines: Lines,
) {
  const line = lineFor({ key, slot }, rows, lines);
  const state = starterState({ key, slot }, rows, states, lines);

  return { line, left: state?.left ?? 1 };
}

/**
 * The one thing to do about a slot, if anything: start somebody off your
 * bench, add a free agent, or go and look for one. Each slot gets at most
 * one, the one worth most, so the page says what to do once and where it
 * applies rather than in a box of advice, a list under every slot and a
 * bench table, which used to name the same swap three times.
 */
export type Move =
  | { kind: "start"; key: string; name: string; says: string; gains: number }
  | { kind: "add"; key: string; name: string; says: string; gains: number }
  | { kind: "find"; position: string };

/** a slot's starter, or an empty slot by the key its worry gave it */
export function movesFor(input: {
  /** the bench swaps the best lineup makes, in the order it found them */
  swaps: { starts: string; benches: string; gains: number }[];
  /** starters who will not play, and an empty slot, each with its best free agent */
  worries: { key: string; slot: string; how: "bad" | "warn"; fill?: Fill }[];
  /** how a player reads beside his name: "10.0 @ NYJ" */
  says: (key: string) => string;
  nameOf: (key: string) => string;
}): Map<string, Move> {
  const moves = new Map<string, Move>();

  for (const swap of input.swaps) {
    if (swap.gains >= WORTH_A_MOVE && !moves.has(swap.benches)) {
      moves.set(swap.benches, {
        kind: "start", key: swap.starts, name: input.nameOf(swap.starts),
        says: input.says(swap.starts), gains: swap.gains,
      });
    }
  }

  for (const worry of input.worries) {
    // the bench covers him already, and moving nobody costs nothing
    if (worry.how !== "bad" || moves.has(worry.key)) {
      continue;
    }

    moves.set(worry.key, worry.fill
      ? { kind: "add", key: worry.fill.key, name: worry.fill.name, says: worry.fill.says, gains: worry.fill.gains }
      : { kind: "find", position: FIND_AT[worry.slot] ?? "ALL" });
  }

  return moves;
}

/** a player's line as it reads beside his name: points, then whom he plays */
const lineSays = (key: string, rows: Map<string, SlateRow>, lines: Lines) => {
  const row = rows.get(key);
  const line = lineFor({ key }, rows, lines);

  return line
    ? `${line.blend.toFixed(1)}${row ? ` ${row.home ? "v" : "@"} ${row.opponent}` : ""}`
    : "";
};

function MoveLine(
  { move, onMore, onFind, players }: {
    move: Move;
    onMore?: ((key: string) => void) | undefined;
    onFind?: ((position: string) => void) | undefined;
    players?: { href: string; name: string } | undefined;
  },
) {
  if (move.kind === "find") {
    return (
      <div class="move find">
        <span class="marrow" aria-hidden="true">→</span>
        <span class="mwho">nobody on your bench helps</span>
        {onFind && (
          <button class="textbtn" onClick={() => onFind(move.position)}>
            find a {move.position.toLowerCase()}
          </button>
        )}
      </div>
    );
  }

  return (
    <div class={"move " + move.kind}>
      <span class="marrow" aria-hidden="true">→</span>
      <span class="mwho">
        <span class="mverb">{move.kind === "start" ? "start" : "add"}</span>
        <PlayerName name={move.name} onOpen={onMore ? () => onMore(move.key) : undefined} />
        <i>{move.kind === "add" ? "free agent" : "bench"}{move.says ? ` · ${move.says}` : ""}</i>
      </span>
      <b class="mgain" title="what the move does to your chance of winning this week">
        {gainPct(move.gains)}
      </b>
      {move.kind === "add" && players && (
        <GoLink href={players.href}><span class="lk">add in {players.name}</span></GoLink>
      )}
    </div>
  );
}

function Slot(
  { slot, starter, rows, states, lines, listed, onMore, move, children }: {
    slot: string;
    starter: Side["starters"][number];
    rows: Map<string, SlateRow>;
    states: Map<string, GameState>;
    lines: Lines;
    listed: Map<string, Listed>;
    onMore?: ((key: string) => void) | undefined;
    move?: Move | undefined;
    children?: ComponentChildren;
  },
) {
  const his = lineAndLeft(starter.key, slot, rows, states, lines);
  const row = rows.get(starter.key);
  const locked = starterState(starter, rows, states, lines)?.where !== "pre";

  return (
    <section class={"slot-card" + (move ? " moved" : "")}>
      <h3>
        <span class="chip">{slot}</span>
        <PlayerName
          name={nameOf(starter.key, rows, lines, starter.name)}
          team={his.line?.team}
          onOpen={onMore ? () => onMore(starter.key) : undefined}
        />
        {row?.bye && <span class="badge bad">bye</span>}
        <Marks his={listed.get(starter.key)} row={row} />
        {locked && <span class="badge even lock">locked</span>}
      </h3>

      <div class="slot-figs">
        {/* nothing is scored before kickoff, and a zero there reads as
            a player who went out and did nothing */}
        {his.left < 1 && (
          <Fig label="scored" col="scored">{scoredSays(starter.points)}</Fig>
        )}
        {row?.bye ? <Fig label="proj" col="proj">–</Fig> : <Numbers line={his.line} left={his.left} />}
      </div>
      {children}
    </section>
  );
}

/**
 * Your bench, plainly: who is on it and what each projects. Any of them
 * worth starting is already named on the row of the starter he replaces,
 * so this is a list to glance at, folded until opened.
 */
function BenchList(
  { side, rows, states, lines, listed, onMore }: {
    side: Side;
    rows: Map<string, SlateRow>;
    states: Map<string, GameState>;
    lines: Lines;
    listed: Map<string, Listed>;
    onMore?: ((key: string) => void) | undefined;
  },
) {
  const [open, setOpen] = useState(false);
  const bench = side.bench
    .map((p) => ({ p, line: lineFor({ key: p.key }, rows, lines) }))
    .sort((a, b) => (b.line?.blend ?? -1) - (a.line?.blend ?? -1));

  if (!bench.length) {
    return null;
  }

  return (
    <div class="benchlist">
      <button class="slot-card benchfold" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <b>bench</b>
        <span>{bench.length} {bench.length === 1 ? "player" : "players"}</span>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"
          style={open ? { transform: "rotate(180deg)" } : undefined}>
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor"
            stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      {open && (
        <ul class="benchrows">
          {bench.map(({ p, line }) => {
            const row = rows.get(p.key);
            const { left } = lineAndLeft(p.key, undefined, rows, states, lines);

            return (
              <li key={p.key}>
                <span class="optname">
                  <PlayerName
                    name={nameOf(p.key, rows, lines, p.name)}
                    team={line?.team}
                    onOpen={onMore ? () => onMore(p.key) : undefined}
                  />
                  {row?.bye && <span class="badge bad">bye</span>}
                  <Marks his={listed.get(p.key)} row={row} />
                </span>
                <span class="optfigs">
                  {row?.bye ? <Fig label="proj" col="proj">–</Fig> : <Numbers line={line} left={left} />}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Lineup(
  { side, slots, rows, states, lines, listed, onMore, moves, onFind, players, worries }: {
    side: Side;
    slots: string[] | null;
    rows: Map<string, SlateRow>;
    states: Map<string, GameState>;
    lines: Lines;
    listed: Map<string, Listed>;
    onMore?: ((key: string) => void) | undefined;
    moves: Map<string, Move>;
    onFind?: ((position: string) => void) | undefined;
    players?: { href: string; name: string } | undefined;
    worries: Worry[];
  },
) {
  // which columns any row fills, so a wide screen can head the rows once
  // and keep every figure under its own label however many a row has
  const lefts = [...side.starters, ...side.bench].map((p) =>
    lineAndLeft(p.key, undefined, rows, states, lines).left);
  const started = side.starters.some((p) => lineAndLeft(p.key, p.slot, rows, states, lines).left < 1);
  const midway = lefts.some((left) => left > 0 && left < 1);
  const empty = worries.filter((w) => w.name === "nobody");
  // the starters in the order the league lists its slots
  const order = (slots ?? []).filter((s) => !["BN", "IR", "TAXI"].includes(s));
  const starters = [...side.starters].sort((a, b) => order.indexOf(a.slot) - order.indexOf(b.slot));

  return (
    <div class={"lineup" + (started ? " has-scored" : "") + (midway ? " has-left" : "")}>
    <div class="stack">
      <div class="slot-head" aria-hidden="true">
        {started && <i class="c-scored">scored</i>}
        <i class="c-proj">proj</i>
        {midway && <i class="c-left">to come</i>}
        <i class="c-range" title="floor to ceiling: the middle 80% of how his week can go">range</i>
      </div>
      {starters.map((starter, i) => {
        const move = moves.get(starter.key);

        return (
          <Slot
            key={starter.key + i}
            slot={starter.slot}
            starter={starter}
            rows={rows}
            states={states}
            lines={lines}
            listed={listed}
            onMore={onMore}
            move={move}
          >
            {move && <MoveLine move={move} onMore={onMore} onFind={onFind} players={players} />}
          </Slot>
        );
      })}
      {empty.map((w) => {
        const move = moves.get(w.key);

        return (
          <section class="slot-card moved" key={w.key}>
            <h3>
              <span class="chip">{w.slot}</span>
              <b class="nobody">nobody</b>
              <span class="badge bad">empty</span>
            </h3>
            <div class="slot-figs" />
            {move && <MoveLine move={move} onMore={onMore} onFind={onFind} players={players} />}
          </section>
        );
      })}
    </div>
      <BenchList side={side} rows={rows} states={states} lines={lines} listed={listed} onMore={onMore} />
    </div>
  );
}

/**
 * When the next of your starters plays: the earliest kickoff among the
 * ones whose games have not started. Nothing when none of them has a
 * kickoff the scoreboard gave, or all of them have started.
 */
export interface NextLock {
  at: number;
  /** the starters whose games kick off then */
  who: string[];
}

export function nextLockOf(states: (GameState | null)[]): number | null {
  const ahead = states
    .filter((state): state is GameState =>
      Boolean(state && state.where === "pre" && state.kickoff))
    .map((state) => state.kickoff!);

  return ahead.length ? Math.min(...ahead) : null;
}

/**
 * The next kickoff among your starters, the way you would say it: in
 * minutes or hours when it is close, since "kickoff in 40 min" is a
 * nudge and a clock time is not, and as a day and a time further off.
 * Kickoff rather than lock, because that is the word people use, and a
 * lineup locking at kickoff goes without saying.
 */
export function kickoffSays(at: number, now: number = Date.now()): string {
  const mins = Math.round((at - now) / 60000);

  if (mins <= 0) {
    return "kicking off now";
  }

  if (mins < 60) {
    return `kickoff in ${mins} min`;
  }

  if (mins < 6 * 60) {
    const hours = Math.floor(mins / 60);
    const rest = mins % 60;

    return `kickoff in ${hours}h${rest ? ` ${rest}m` : ""}`;
  }

  return "kickoff " + new Date(at).toLocaleString([], {
    weekday: "short", hour: "numeric", minute: "2-digit",
  });
}

/** when the week's lines were built, in the words somebody checking uses */
export function freshSays(generated: string, now: number = Date.now()): string {
  const at = Date.parse(generated);

  if (!Number.isFinite(at)) {
    return "";
  }

  const days = (now - at) / 86400000;
  const when = new Date(at).toLocaleString([], days < 6
    ? { weekday: "short", hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric" });

  return "projections from " + when;
}

/** the next lock and whose it is, among the starters still to play */
function nextLockIn(
  side: Side, rows: Map<string, SlateRow>, states: Map<string, GameState>,
  lines: Lines,
): NextLock | null {
  const each = side.starters.map((starter) => ({
    starter, state: starterState(starter, rows, states, lines),
  }));
  const at = nextLockOf(each.map((e) => e.state));

  if (at === null) {
    return null;
  }

  return {
    at,
    who: each.filter((e) => e.state?.kickoff === at && e.state.where === "pre")
      .map((e) => nameOf(e.starter.key, rows, lines, e.starter.name)),
  };
}

/** a list of names the way it is said: A, B and 2 more */
function namesSay(names: string[]): string {
  if (names.length <= 2) {
    return names.join(" and ");
  }

  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/**
 * Where a game has got to, read off both lineups: before anybody has
 * kicked off, live while one of their games is being played, under way
 * when some are done and none is on (a Sunday evening before the late
 * game), and final.
 */
type Phase = "pre" | "live" | "between" | "final";

function phaseOf(
  game: Matchup, rows: Map<string, SlateRow>,
  states: Map<string, GameState>, lines: Lines,
): Phase {
  const all = game.sides.flatMap((side) => side.starters)
    .map((starter) => starterState(starter, rows, states, lines));

  if (all.some((state) => state?.where === "in")) {
    return "live";
  }

  if (all.length > 0 && all.every((state) => state && state.left <= 0)) {
    return "final";
  }

  return all.some((state) => state && state.where !== "pre") ? "between" : "pre";
}

/**
 * The win chance as one word, so the scoreline can be read from across
 * a room. The bands are wide on purpose: 52% and 48% are the same game.
 */
function verdictOf(odds: number, phase: Phase, ahead: boolean) {
  if (phase === "final") {
    return ahead ? { word: "won", tone: "up" } : { word: "lost", tone: "no" };
  }

  if (odds >= 0.6) {
    return { word: "favored", tone: "up" };
  }

  if (odds <= 0.4) {
    return { word: "underdog", tone: "no" };
  }

  return { word: "toss-up", tone: "even" };
}

/**
 * The win chance drawn as a ring, which is the one thing on the page a
 * reader wants before anything else and reads at a glance in a way a
 * sentence in grey does not.
 */
function Ring({ odds, tone }: { odds: number; tone: string }) {
  const r = 30;
  const round = 2 * Math.PI * r;

  return (
    <svg class={"ring tone-" + tone} viewBox="0 0 72 72" aria-hidden="true">
      <circle class="track" cx="36" cy="36" r={r} />
      <circle
        class="fill" cx="36" cy="36" r={r}
        stroke-dasharray={`${round * odds} ${round}`}
        transform="rotate(-90 36 36)"
      />
    </svg>
  );
}

/**
 * Your week in one card: who you are playing, the score, what each side
 * is on course for, and how often you win from here.
 *
 * It sits first because it is the question the tab is opened to answer.
 * The slot by slot card that used to be the only place this was said
 * sat under eight lineup cards and the bench.
 */
function Scoreline(
  { game, at, odds, projected, phase, week, teams, lock }: {
    game: Matchup;
    at: number;
    odds: number;
    projected: [number, number];
    phase: Phase;
    week: number | undefined;
    teams: Roster[];
    /** when your next starter's game kicks off, and whose, if one is still to */
    lock: NextLock | null;
  },
) {
  const me = game.sides[at]!;
  const them = game.sides[1 - at]!;
  const ahead = me.points > them.points;
  const verdict = verdictOf(odds, phase, ahead);
  const side = (who: Side, proj: number, cls: string) => (
    <div class={"hside " + cls}>
      <span class="nm">{who.owner}</span>
      <span class="rec">{standingSays(teams, who.owner)}</span>
      <span class="pts">{scoredSays(who.points)}</span>
      {/* where the side finishes on average, counting what it has; once
          the game is over that is the score above, so it goes */}
      {phase !== "final" && (
        <span class="proj"><i>proj</i>{scoredSays(proj)}</span>
      )}
    </div>
  );

  return (
    // tone-, since a bare "up" is the page's own class for a green figure
    // and took every word on the card with it
    <section class={"hero tone-" + verdict.tone} aria-label="your game">
      <div class="htop">
        <span>{week ? "week " + week : "this week"}</span>
        <span class={"phase " + phase}>
          {phase === "live" && <i class="pulse" aria-hidden="true" />}
          {PHASE_SAYS[phase]}
        </span>
      </div>
      <div class="hbody">
        {side(me, projected[at]!, "me")}
        {/* the figure in the ring and the word under it, since a word
            inside the ring has to be smaller than anybody reads */}
        <div class="hodds">
          <span class="hring">
            <Ring odds={odds} tone={verdict.tone} />
            <span class="hpct">{pct(odds)}</span>
          </span>
          <span class="hword">{verdict.word}</span>
        </div>
        {side(them, projected[1 - at]!, "them")}
      </div>
      {/* the next lock on a line of its own, since it is a warning about
          something you can still do and the corner says how the game is */}
      {lock && phase !== "final" && (
        <div class={"hlock" + (lock.at - Date.now() < 3600000 ? " soon" : "")}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor"
              stroke-width="1.6" />
            <path d="M8 4.8V8l2.2 1.4" fill="none" stroke="currentColor"
              stroke-width="1.6" stroke-linecap="round" />
          </svg>
          {/* kickoff is a noun, so the line reads the same whether one
              player plays then or three */}
          <span class="ltext">
            <b>{kickoffSays(lock.at)}</b>
            {lock.who.length > 0 && <span class="lwho">{namesSay(lock.who)}</span>}
          </span>
        </div>
      )}
    </section>
  );
}

/** what the corner of the scoreline says at each point in the week */
const PHASE_SAYS: Record<Phase, string> = {
  pre: "before kickoff", live: "live", between: "under way", final: "final",
};

/** a slot's name as the players tab filters by it */
const FIND_AT: Record<string, string> = {
  QB: "QB", RB: "RB", WR: "WR", TE: "TE", K: "K", DEF: "DEF",
  FLEX: "FLEX", WRRB_FLEX: "FLEX", REC_FLEX: "FLEX",
};

interface Worry {
  key: string;
  name: string;
  slot: string;
  says: string;
  how: "bad" | "warn";
  /** what the injury report calls it, IR or Out, worn as a badge by the name */
  status?: string;
  /** the free agent who would do the most in his place, and what he is worth */
  fill?: Fill;
}

interface Fill {
  key: string;
  name: string;
  /** "14.9 v CIN" */
  says: string;
  /** what starting him in the slot does to your win chance */
  gains: number;
}

/** who can play in each slot, by the positions the slate gives */
const PLAYS_IN: Record<string, string[]> = {
  QB: ["QB"], RB: ["RB"], WR: ["WR"], TE: ["TE"], K: ["K"], DEF: ["DEF"],
  FLEX: ["RB", "WR", "TE"], WRRB_FLEX: ["RB", "WR"], REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
};

/**
 * The free agent who would do the most for you in a slot you cannot fill
 * from your bench, priced the way the rest of the page prices a swap:
 * your win chance with him started in the slot, against the one you
 * have. Only players nobody in the league has, whose game has not
 * started, and who are not on bye or ruled out are considered, and of
 * those the three best lines are priced and the best of them kept.
 */
function fillFor(
  worry: Worry, side: Side, against: Side, at: number, odds: number,
  rostered: Set<string>, pricing: {
    rows: Map<string, SlateRow>; states: Map<string, GameState>; lines: Lines;
    listed: Map<string, Listed>; remainder: Map<string, number[]> | null;
  },
): Fill | undefined {
  const fits = PLAYS_IN[worry.slot];

  if (!fits) {
    return undefined;
  }

  const free = [...pricing.rows.entries()]
    .filter(([key, row]) => fits.includes(row.position) && !rostered.has(key) &&
      !row.bye && !row.ruledOut && row.blend > 0 &&
      !WORRYING.has(hurtWord(pricing.listed.get(key), row)?.status ?? "") &&
      (starterState({ key, slot: worry.slot }, pricing.rows, pricing.states,
        pricing.lines)?.where ?? "pre") === "pre")
    .sort((a, b) => b[1].blend - a[1].blend)
    .slice(0, 3);

  let best: Fill | undefined;

  for (const [key, row] of free) {
    const him = { key, name: row.name, team: row.team, slot: worry.slot, points: 0 };
    const starters = worry.name === "nobody"
      ? [...side.starters, him]
      : side.starters.map((s) => s.key === worry.key ? him : s);
    const mine = { ...side, starters };
    const game: Matchup = { sides: at === 0 ? [mine, against] : [against, mine] };
    const gains = standingFor(game, pricing).odds[at]! - odds;

    if (!best || gains > best.gains) {
      best = {
        key, name: row.name, gains,
        says: `${row.blend.toFixed(1)} ${row.home ? "v" : "@"} ${row.opponent}`,
      };
    }
  }

  return best;
}

/**
 * The starters who need a look before kickoff: ruled out, on a list, on
 * bye, or a slot with nobody in it. A badge on the fourth card down is
 * easy to scroll past, and a zero in your lineup is the most expensive
 * thing on the page, so they are gathered at the top with the way to
 * fix each.
 *
 * Only games still to kick off count. Once a player's game has started
 * there is nothing to do about him.
 */
function worriesOf(
  side: Side, slots: string[] | null, rows: Map<string, SlateRow>,
  states: Map<string, GameState>, lines: Lines, listed: Map<string, Listed>,
): Worry[] {
  const out: Worry[] = [];

  for (const starter of side.starters) {
    const state = starterState(starter, rows, states, lines);

    if (state && state.where !== "pre") {
      continue;
    }

    const name = nameOf(starter.key, rows, lines, starter.name);
    const row = rows.get(starter.key);
    const hurt = hurtWord(listed.get(starter.key), row);

    if (row?.bye) {
      out.push({ key: starter.key, name, slot: starter.slot, status: "Bye", says: "", how: "bad" });
    } else if (hurt) {
      out.push({
        key: starter.key, name, slot: starter.slot,
        how: WORRYING.has(hurt.status) ? "bad" : "warn",
        status: hurt.status,
        says: hurt.part ? hurt.part.toLowerCase() : "",
      });
    }
  }

  const starting = (slots ?? []).filter((s) => !["BN", "IR", "TAXI"].includes(s));
  const filled = new Map<string, number>();

  for (const starter of side.starters) {
    filled.set(starter.slot, (filled.get(starter.slot) ?? 0) + 1);
  }

  for (const slot of starting) {
    const left = filled.get(slot) ?? 0;

    if (left > 0) {
      filled.set(slot, left - 1);
    } else {
      out.push({ key: "empty-" + slot + out.length, name: "nobody", slot, status: "Empty", says: "", how: "bad" });
    }
  }

  // the ones that cost a whole slot first
  return out.sort((a, b) => Number(a.how === "warn") - Number(b.how === "warn"));
}

export function MyMatchup(props: Props) {
  const { mine, mineId, rows, slots, slate, onMore } = props;
  const { states, remainder, trouble } = useLiveWeek(
    props.picked?.season, props.picked?.week, props.pays ?? {},
    props.provider, props.scoreboard);

  const shift = catchShiftOf(props.pays ?? {}, props.boardPerCatch);
  const lines = useMemo(
    () => linesFor(props.players, props.picked?.week, shift),
    [props.players, props.picked?.week, shift]);
  const games = useMemo(
    () => settledGames(props.games, rows, states, lines),
    [props.games, rows, states, lines],
  );
  const ours = useMemo(
    () => myGameIn(games, mine, mineId), [games, mine, mineId]);
  // the headline and the card under it have to price the same game
  const standing = useMemo(
    () => ours && states
      ? standingFor(ours.game, { rows, states, lines, remainder })
      : undefined,
    [ours, rows, states, lines, remainder],
  );
  const odds = ours ? standing?.odds[ours.at] : undefined;
  const worries = useMemo(() => {
    if (!ours || !states || odds === undefined) {
      return [];
    }

    const found = worriesOf(ours.side, slots, rows, states, lines, props.listed);
    // everybody on a roster in the league, so a fill is somebody you can add
    const rostered = new Set([
      ...(props.teams ?? []).flatMap((team) => team.keys.map((p) => p.key)),
      ...ours.side.starters.map((p) => p.key),
      ...ours.side.bench.map((p) => p.key),
      ...ours.against.starters.map((p) => p.key),
      ...ours.against.bench.map((p) => p.key),
    ]);
    const pricing = { rows, states, lines, listed: props.listed, remainder };

    return found.map((worry) => {
      if (worry.how !== "bad") {
        return worry;
      }

      const fill = fillFor(
        worry, ours.side, ours.against, ours.at, odds, rostered, pricing);

      // a free agent worth less than a point is not worth a claim
      return fill && fill.gains >= WORTH_A_MOVE ? { ...worry, fill } : worry;
    });
  }, [ours, slots, rows, states, lines, props.listed, props.teams, odds, remainder]);
  // the lineup the bench makes best, then the free agents for the slots
  // it cannot fill, and what all of it together does to the week
  const best = useMemo(
    () => (ours && states
      ? bestLineupFor(ours.side, ours.against, slots, { rows, states, lines, remainder })
      : null),
    [ours, slots, rows, states, lines, remainder],
  );
  const moves = useMemo(() => movesFor({
    swaps: best?.swaps ?? [],
    worries,
    says: (key) => lineSays(key, rows, lines),
    nameOf: (key) => nameOf(key, rows, lines, ours
      ? [...ours.side.starters, ...ours.side.bench].find((p) => p.key === key)?.name
      : undefined),
  }), [best, worries, rows, lines, ours]);
  const planned = useMemo(() => {
    if (!ours || !states || !best || moves.size === 0) {
      return null;
    }

    let starters = [...best.starters];

    for (const [key, move] of moves) {
      if (move.kind !== "add") {
        continue;
      }

      const him = { key: move.key, name: move.name, slot: "", points: 0 };
      const at = starters.findIndex((p) => p.key === key);

      if (at >= 0) {
        starters[at] = { ...him, slot: starters[at]!.slot };
      } else {
        const empty = worries.find((w) => w.key === key);

        starters = [...starters, { ...him, slot: empty?.slot ?? "" }];
      }
    }

    const side = { ...ours.side, starters };
    const game: Matchup = { sides: ours.at === 0 ? [side, ours.against] : [ours.against, side] };

    return standingFor(game, { rows, states, lines, remainder }).odds[ours.at]!;
  }, [ours, states, best, moves, worries, rows, lines, remainder]);
  const moveCount = [...moves.values()].filter((m) => m.kind !== "find").length;
  const league = props.leagueOf ?? null;
  const goPlayers = league
    ? { href: playersLink(league), name: PROVIDER_NAME[league.provider] }
    : undefined;

  /**
   * Still on its way: the week's lines, or the league's games. Priced
   * without the lines, the game came out of the board alone, so the
   * scoreline said one thing for a second and then another, and missed
   * who was ruled out. A read that failed says so in the status, and
   * the page stops waiting for it.
   */
  const waiting = !props.status &&
    (!slate || (!ours && props.games.length === 0));

  if (!props.weeks.length) {
    return (
      <div class="empty">
        <b>No week has been built yet.</b> Weekly projections need a few
        games of this season's snaps and targets, so they start about a
        month in. Until then, use <b>draft</b> and <b>team</b>.
      </div>
    );
  }

  return (
    <>
      <div class="weekbar">
        <WeekPicker
          weeks={props.weeks} picked={props.picked} onWeek={props.onWeek}
        />

        {/* when the week's lines were built, since a Sunday morning
            ruling is in them or it is not, and nothing else says which */}
        {slate?.generated && !props.status && (
          <span class="fresh">{freshSays(slate.generated)}</span>
        )}
        <span id="status">{props.status ?? ""}</span>
      </div>

      {trouble && <p class="hint">{trouble}</p>}

      {slate?.preseason && (
        <p class="hint">
          Preseason: projections are based on last season.
        </p>
      )}

      {ours && states && !waiting && (
        <>
          {standing && odds !== undefined && (
            <Scoreline
              game={ours.game}
              at={ours.at}
              odds={odds}
              projected={standing.projected}
              phase={phaseOf(ours.game, rows, states, lines)}
              week={props.picked?.week}
              teams={props.teams ?? []}
              lock={nextLockIn(ours.side, rows, states, lines)}
            />
          )}
          {/* on a wide screen the lineup sits beside the game it is in;
              on a phone the two follow each other */}
          <div class="mcols rhythm">
          <div class="mcol mine rhythm">
          <div class="lineuphead">
            <h2>your lineup</h2>
            {league && (
              <GoLink href={lineupLink(league)}>
                set it in {PROVIDER_NAME[league.provider]}
              </GoLink>
            )}
          </div>
          {odds !== undefined && moveCount > 0 && planned !== null && (
            <p class="plan">
              <b>{moveCount} {moveCount === 1 ? "move" : "moves"}</b>
              <span>{pct(odds)} → <b class="up">{pct(planned)}</b> to win</span>
            </p>
          )}
          <Lineup
            side={ours.side}
            slots={slots}
            rows={rows}
            states={states}
            lines={lines}
            listed={props.listed}
            onMore={onMore}
            moves={moves}
            onFind={props.onFind}
            players={goPlayers}
            worries={worries}
          />
          </div>
          <div class="mcol act rhythm">
          <h2>head to head</h2>
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
          </div>
          </div>
        </>
      )}

      {/* the week, the league's games and the scoreboard each take a
          moment; until all three are in, the page shows its outline
          rather than saying there is no game */}
      {(waiting || (ours && !states)) && (
        <Skeleton saying="loading your week" />
      )}

      {!ours && !waiting && (
        <p class="hint">
          No game this week. Rankings are under <b>players</b>.
        </p>
      )}
    </>
  );
}
