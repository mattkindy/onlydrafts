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
import { leadFor, type Explanation } from "../lib/explain.ts";
import {
  alternativesFor, lineFor, linesFor, myGameIn, settledGames, standingFor,
  starterState, type Alternative, type GameState, type Lines, type SlotChoice,
} from "../lib/matchups.ts";
import type { League, Matchup, Roster, Side } from "../lib/providers.ts";
import { scoredSays, type Pays, type Player } from "../lib/scoring.ts";
import {
  catchShiftOf, hurtWord, type Slate, type SlateRow, type WeekRef,
} from "../lib/slate.ts";
import { WeatherMark } from "./WeatherMark.tsx";
import { WeekPicker } from "./WeekPicker.tsx";
import { Advice, gainPct, nameOf, pct, WORTH_A_MOVE } from "./Advice.tsx";
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

/** a swap's worth, with anything inside a point either way said as even */
const signed = (gains: number) =>
  Math.abs(gains) < WORTH_A_MOVE ? "even"
    : gains > 0 ? gainPct(gains) : (100 * gains).toFixed(0) + "%";

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

/** a player's line for the week and how much of his game is left to play */
function lineAndLeft(
  key: string, slot: string | undefined, rows: Map<string, SlateRow>,
  states: Map<string, GameState>, lines: Lines,
) {
  const line = lineFor({ key, slot }, rows, lines);
  const state = starterState({ key, slot }, rows, states, lines);

  return { line, left: state?.left ?? 1 };
}

/** each bench player's best swap, so the whole bench shows whether or not it helps */
function bestSwaps(choices: SlotChoice[]) {
  const best = new Map<string, { option: Alternative; choice: SlotChoice }>();

  for (const choice of choices) {
    for (const option of choice.options) {
      const had = best.get(option.key);

      if (!had || option.gains > had.option.gains) {
        best.set(option.key, { option, choice });
      }
    }
  }

  return [...best.values()].sort((a, b) => b.option.gains - a.option.gains);
}

function Bench(
  { choices, rows, states, lines, listed, onMore }: {
    choices: SlotChoice[];
    rows: Map<string, SlateRow>;
    states: Map<string, GameState>;
    lines: Lines;
    listed: Map<string, Listed>;
    onMore?: ((key: string) => void) | undefined;
  },
) {
  const swaps = bestSwaps(choices);
  const helps = swaps.some(({ option }) => option.gains >= WORTH_A_MOVE);
  /**
   * The whole bench is worth seeing when one of them would help. When
   * none would, it is seven rows of minus signs, so it waits behind a
   * line that says as much.
   */
  const [open, setOpen] = useState(false);

  if (swaps.length === 0) {
    return null;
  }

  if (!helps && !open) {
    return (
      <button class="slot-card benchfold" onClick={() => setOpen(true)}>
        <b>bench</b>
        <span>
          {swaps.length} {swaps.length === 1 ? "player" : "players"}, none
          would raise it
        </span>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor"
            stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    );
  }

  return (
    <section class="slot-card">
      <h3>bench</h3>
      <ul class="options">
        {swaps.map(({ option, choice }) => {
          const his = lineAndLeft(option.key, undefined, rows, states, lines);

          return (
            <li key={option.key} class={option.locked ? "shut" : ""}>
              <PlayerName
                name={nameOf(option.key, rows, lines, option.name)}
                team={his.line?.team}
                onOpen={onMore ? () => onMore(option.key) : undefined}
              />
              <span class={option.gains >= WORTH_A_MOVE ? "fig delta up" : "fig delta"}>
                <i>win %</i>{signed(option.gains)}
              </span>
              <div class="optfigs">
                <Numbers line={his.line} left={his.left} />
                <Fig label={`instead of ${nameOf(
                  choice.starter.key, rows, lines, choice.starter.name)}`}>
                  {choice.slot}
                </Fig>
                <Fig label="outscores him">{pct(option.outscores)}</Fig>
                <Marks his={listed.get(option.key)} row={rows.get(option.key)} />
                {option.locked && <span class="badge even">locked</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
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
  const at = (key: string, slot?: string) =>
    lineAndLeft(key, slot, rows, states, lines);
  const his = at(choice.starter.key, choice.slot);
  /**
   * Only the swaps that gain you something. Listing the losing ones put
   * the same five bench players under every running back slot, which is
   * five screens of rows telling you to do nothing.
   */
  const better = choice.options.filter((option) => option.gains >= WORTH_A_MOVE);

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
                  <span class="fig delta up">
                    <i>win %</i>{signed(option.gains)}
                  </span>
                  <div class="optfigs">
                    <Numbers line={other.line} left={other.left} />
                    <Fig label="outscores him">{pct(option.outscores)}</Fig>
                    <Marks
                      his={listed.get(option.key)}
                      row={rows.get(option.key)}
                    />
                    {option.locked && <span class="badge even">locked</span>}
                  </div>
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
    <div class="stack">
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
      <Bench
        choices={choices}
        rows={rows}
        states={states}
        lines={lines}
        listed={listed}
        onMore={onMore}
      />
    </div>
  );
}

/**
 * When the next of your starters locks: the earliest kickoff among the
 * ones whose games have not started. Nothing when none of them has a
 * kickoff the scoreboard gave, or all of them have started.
 */
export function nextLockOf(states: (GameState | null)[]): number | null {
  const ahead = states
    .filter((state): state is GameState =>
      Boolean(state && state.where === "pre" && state.kickoff))
    .map((state) => state.kickoff!);

  return ahead.length ? Math.min(...ahead) : null;
}

/**
 * A lock time the way you would say it: in minutes or hours when it is
 * close, since "locks in 40 min" is a nudge and a clock time is not, and
 * as a day and a time when it is further off.
 */
export function lockSays(at: number, now: number = Date.now()): string {
  const mins = Math.round((at - now) / 60000);

  if (mins <= 0) {
    return "locking now";
  }

  if (mins < 60) {
    return `locks in ${mins} min`;
  }

  if (mins < 6 * 60) {
    const hours = Math.floor(mins / 60);
    const rest = mins % 60;

    return `locks in ${hours}h${rest ? ` ${rest}m` : ""}`;
  }

  return "locks " + new Date(at).toLocaleString([], {
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

/** where a game has got to, read off both lineups */
type Phase = "pre" | "live" | "final";

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

  return all.some((state) => state && state.where !== "pre") ? "live" : "pre";
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
    return { word: phase === "live" ? "on course" : "favored", tone: "up" };
  }

  if (odds <= 0.4) {
    return { word: phase === "live" ? "chasing" : "underdog", tone: "no" };
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
    /** when your next starter's game kicks off, if one is still to */
    lock: number | null;
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
      <span class="proj">
        {phase === "final" ? "final" : "on course for " + scoredSays(proj)}
      </span>
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
          {lock !== null && phase !== "final"
            ? (phase === "live" ? "live · " : "") + lockSays(lock)
            : phase === "pre" ? "before kickoff" : phase}
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
    </section>
  );
}

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
      out.push({ key: starter.key, name, slot: starter.slot, says: "on bye", how: "bad" });
    } else if (hurt && WORRYING.has(hurt.status)) {
      out.push({
        key: starter.key, name, slot: starter.slot, how: "bad",
        says: hurt.status.toLowerCase() + (hurt.part ? ", " + hurt.part.toLowerCase() : ""),
      });
    } else if (hurt) {
      out.push({
        key: starter.key, name, slot: starter.slot, how: "warn",
        says: hurt.status.toLowerCase() + (hurt.part ? ", " + hurt.part.toLowerCase() : ""),
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
      out.push({ key: "empty-" + slot + out.length, name: "nobody", slot, says: "empty slot", how: "bad" });
    }
  }

  // the ones that cost a whole slot first
  return out.sort((a, b) => Number(a.how === "warn") - Number(b.how === "warn"));
}

function Worries(
  { worries, onMore, onFind, players }: {
    worries: Worry[];
    onMore?: ((key: string) => void) | undefined;
    onFind?: ((position: string) => void) | undefined;
    /** the provider's free agents page, where an add is made */
    players?: { href: string; name: string } | undefined;
  },
) {
  if (worries.length === 0) {
    return null;
  }

  const bad = worries.filter((w) => w.how === "bad").length;

  return (
    <section class={"worries" + (bad ? " bad" : "")}>
      <h3>
        {bad
          ? `${bad} starter${bad === 1 ? "" : "s"} won't play`
          : "worth a look before kickoff"}
      </h3>
      <ul>
        {worries.map((w) => (
          <li key={w.key} class={w.how}>
            <div class="wrow">
              <span class="chip">{w.slot}</span>
              <span class="wwho">
                {w.name === "nobody"
                  ? <b>nobody</b>
                  : (
                    <PlayerName
                      name={w.name}
                      onOpen={onMore ? () => onMore(w.key) : undefined}
                    />
                  )}
                <i>{w.says}</i>
              </span>
              {w.how === "bad" && onFind && !w.fill && (
                <button
                  class="quiet"
                  onClick={() => onFind(FIND_AT[w.slot] ?? "ALL")}
                >
                  find a {FIND_AT[w.slot]?.toLowerCase() ?? "player"}
                </button>
              )}
            </div>
            {/* the one free agent worth adding for the slot, so the box
                answers what to do about it rather than only saying it */}
            {w.fill && (
              <div class="fill">
                <span class="over">best free agent</span>
                <div class="fwho">
                  <PlayerName
                    name={w.fill.name}
                    onOpen={onMore ? () => onMore(w.fill!.key) : undefined}
                  />
                  <i>{w.fill.says}</i>
                  <b class="up">{gainPct(w.fill.gains)} to win</b>
                </div>
                <div class="facts">
                  {players && (
                    <GoLink href={players.href}>add in {players.name}</GoLink>
                  )}
                  {onFind && (
                    <button
                      class="textbtn"
                      onClick={() => onFind(FIND_AT[w.slot] ?? "ALL")}
                    >
                      other {FIND_AT[w.slot] ?? "player"}s
                    </button>
                  )}
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
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
              lock={nextLockOf(ours.side.starters.map((starter) =>
                starterState(starter, rows, states, lines)))}
            />
          )}
          <Worries
            worries={worries} onMore={onMore} onFind={props.onFind}
            players={goPlayers}
          />
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
            lean
          />
          <div class="lineuphead">
            <h2>your lineup</h2>
            {league && (
              <GoLink href={lineupLink(league)}>
                set it in {PROVIDER_NAME[league.provider]}
              </GoLink>
            )}
          </div>
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
