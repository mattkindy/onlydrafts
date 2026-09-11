/**
 * This week's head to head games, with a win chance for each side.
 *
 * The provider says what everybody has scored so far. What is left to
 * come is drawn from the week's projections, and how much is left
 * depends on where each man's game is: nothing more for a game that has
 * finished, a whole week for one that has not kicked off, and a share of
 * one for a game in progress. The public ESPN scoreboard is what says
 * which of the three a game is in, and it needs no sign in.
 *
 * Men in the same game share the factors the season draws share, and
 * what they have scored is evidence about those factors, so a
 * quarterback hot at half time lifts his receivers.
 */

import {
  factorFor, factorsOf, mixFor, PASS_CATCHERS, posteriorDraws, posteriorFor,
  type From, type Mix,
} from "./copula.ts";
import type { Matchup, Side } from "./providers.ts";
import {
  FLEX_POSITIONS, knownSlot, lineupOf, slotTakes, type Player,
} from "./scoring.ts";
import type { SlateRow } from "./slate.ts";
import {
  normalCdf, normalQuantile, quantileOf, weeksFromSpread, type Spread,
} from "./spread.ts";
import { winChance } from "./winShare.ts";

export const SCOREBOARD =
  "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";

export interface GameState {
  where: "pre" | "in" | "post";
  /** how much of the game is still to play, nought to one */
  left: number;
}

/** four quarters of fifteen minutes */
const REGULATION = 60;

/** and an overtime period, which is ten in the regular season */
const OVERTIME = 10;

/**
 * ESPN's code for a pro team against the board's, where the two differ.
 * Everything else already matches, including JAX.
 */
const RENAMED: Record<string, string> = { WSH: "WAS", LAR: "LA" };

const boardTeam = (abbreviation: string) => {
  const code = abbreviation.toUpperCase();

  return RENAMED[code] ?? code;
};

/** minutes and seconds off the clock, as a number of minutes */
function clockMinutes(displayClock: string | undefined): number {
  const said = /(\d+):(\d+)/.exec(displayClock ?? "");

  if (!said) {
    return 0;
  }

  return Number(said[1]) + Number(said[2]) / 60;
}

/**
 * How much of a game in progress is left. Overtime counts as a little
 * more rather than as nothing, since a tie at the whistle still has
 * points to come.
 */
export function fractionLeft(
  period: number | undefined, displayClock: string | undefined,
): number {
  const at = period ?? 1;
  const onTheClock = clockMinutes(displayClock);

  if (at > 4) {
    return Math.min(1, onTheClock / REGULATION);
  }

  const quartersToCome = Math.max(0, 4 - at) * 15;

  return Math.min(1, Math.max(0, (quartersToCome + onTheClock) / REGULATION));
}

interface ScoreboardStatus {
  period?: number;
  displayClock?: string;
  type?: { state?: string };
}

interface ScoreboardEvent {
  status?: ScoreboardStatus;
  competitions?: {
    status?: ScoreboardStatus;
    competitors?: { team?: { abbreviation?: string } }[];
  }[];
}

/** one game's state, read off however the scoreboard describes it */
function stateOf(status: ScoreboardStatus | undefined): GameState {
  const where = status?.type?.state === "in"
    ? "in"
    : status?.type?.state === "post" ? "post" : "pre";

  if (where === "post") {
    return { where, left: 0 };
  }

  if (where === "pre") {
    return { where, left: 1 };
  }

  return { where, left: fractionLeft(status?.period, status?.displayClock) };
}

/** every team playing this week, and where its game has got to */
export function statesFrom(said: {
  events?: ScoreboardEvent[];
}): Map<string, GameState> {
  const out = new Map<string, GameState>();

  for (const event of said.events ?? []) {
    const game = event.competitions?.[0];
    const state = stateOf(game?.status ?? event.status);

    for (const side of game?.competitors ?? []) {
      const code = side.team?.abbreviation;

      if (code) {
        out.set(boardTeam(code), state);
      }
    }
  }

  return out;
}

/**
 * The scoreboard for one week. Asked for by week rather than taken as it
 * comes, because the bare scoreboard is whatever ESPN thinks today is,
 * and the page is looking at the week the slate was built for. Season
 * type two is the regular season.
 */
export async function gameStates(
  season: number, week: number,
): Promise<Map<string, GameState>> {
  const answered = await fetch(
    `${SCOREBOARD}?seasontype=2&week=${week}&dates=${season}`);

  if (!answered.ok) {
    throw new Error("ESPN would not hand over the scoreboard.");
  }

  return statesFrom(await answered.json());
}

/**
 * A man's week read as a spread. An older slate ships only the floor,
 * the middle and the ceiling, and then each quartile is put halfway
 * between the two figures either side of it. Halfway is narrower than
 * the quartile really is, because the residuals are skewed, so a slate
 * that ships them is taken at its word.
 */
export const spreadOf = (row: SlateRow) => ({
  ev: row.blend,
  mid: row.blend,
  low: row.floor,
  high: row.ceiling,
  q1: row.q1 ?? (row.floor + row.blend) / 2,
  q3: row.q3 ?? (row.blend + row.ceiling) / 2,
});

/** the board in this league's terms, by the key a lineup uses for a man */
export type Lines = Map<string, Player>;

/** what anybody knows about a man's week */
export interface Line {
  spread: Spread;
  position: string;
  team: string | null;
  /** the other side of his game, where the week says who it is */
  opponent: string | null;
  /** the middle of it, which is what a projected total adds up */
  blend: number;
  /**
   * True when nobody has a number for this man and the position's stock
   * week is standing in, so a page can say the figure is a guess.
   */
  stock: boolean;
}

/**
 * A plain week for a position, for a man neither the slate nor the board
 * knows. Kickers and defences are the ones this happens to, and either
 * scores about a touchdown most weeks, so counting nought was worse than
 * counting the position's usual.
 */
const STOCK: Record<string, Spread> = {
  K: { ev: 8, q1: 4.5, mid: 7.5, q3: 11, low: 2, high: 15 },
  DEF: { ev: 7, q1: 3, mid: 6, q3: 10, low: -1, high: 17 },
};

/** the stock week for a position, where there is one worth drawing */
export const stockLine = (position: string): Line | null => {
  const spread = STOCK[position];

  if (!spread) {
    return null;
  }

  return {
    spread,
    position,
    team: null,
    opponent: null,
    blend: spread.ev,
    stock: true,
  };
};

/**
 * What the week says about a man, and failing that what the board does.
 *
 * A slate covers the men a weekly model is run for, which leaves out
 * kickers and defences. Those two have a season long game of their own on
 * the board, in this league's scoring, and a game of that is a better
 * guess at the rest of his Sunday than nothing at all. The fixture does
 * not come with it, so he shares no factor with anybody.
 */
export function lineOf(
  key: string, rows: Map<string, SlateRow>, lines?: Lines, position?: string,
): Line | null {
  const row = rows.get(key);

  if (row) {
    return {
      spread: spreadOf(row),
      position: row.position,
      team: row.team.toUpperCase(),
      opponent: row.opponent.toUpperCase() || null,
      blend: row.blend,
      stock: false,
    };
  }

  const man = lines?.get(key);
  const game = man?.game;

  if (!man || !game?.["ev"]) {
    return position ? stockLine(position) : null;
  }

  const ev = game["ev"]!;

  return {
    spread: {
      ev,
      mid: game["mid"] ?? ev,
      low: game["low"] ?? ev,
      high: game["high"] ?? ev,
      q1: game["q1"] ?? ev,
      q3: game["q3"] ?? ev,
    },
    position: man.position,
    team: man.team?.toUpperCase() ?? null,
    opponent: null,
    blend: ev,
    stock: false,
  };
}

/** a man on the field, as the pages that draw him need him */
export interface Starter {
  key: string;
  points?: number;
  /** the seat he is in, which says what position to fall back on */
  slot?: string;
}

/** the position a seat implies, for a man nobody has a line on */
const hintOf = (slot: string | undefined) =>
  slot && slot in STOCK ? slot : undefined;

/** what the week, the board, or the position says about a man in a seat */
export const lineFor = (
  man: Starter, rows: Map<string, SlateRow>, lines?: Lines,
) => lineOf(man.key, rows, lines, hintOf(man.slot));

/** where his game has got to, off whichever team the line gives him */
const stateAt = (line: Line, states: Map<string, GameState>): GameState =>
  (line.team ? states.get(line.team) : null) ?? { where: "pre", left: 1 };

/** the two teams in a man's game, so both sides reach the same name */
const gameOf = (line: Line) =>
  [line.team ?? "", line.opponent ?? ""].sort().join("|");

/**
 * The live draws are all one week, so the factor a game shares needs no
 * week in its name to keep two of them apart.
 */
const THIS_WEEK = 0;

/**
 * Who each team's first pass catcher is this week, which decides the sign
 * he takes the split factor with. Kept per slate, since a week's rows are
 * read once and then asked about for every matchup on the page.
 */
const firsts = new WeakMap<Map<string, SlateRow>, Set<string>>();

function topCatchers(rows: Map<string, SlateRow>): Set<string> {
  const had = firsts.get(rows);

  if (had) {
    return had;
  }

  const best = new Map<string, [string, number]>();

  for (const [key, row] of rows) {
    if (!PASS_CATCHERS.includes(row.position)) {
      continue;
    }

    const team = row.team.toUpperCase();
    const leader = best.get(team);

    if (!leader || row.blend > leader[1]!) {
      best.set(team, [key, row.blend]);
    }
  }

  const top = new Set([...best.values()].map(([key]) => key));
  firsts.set(rows, top);

  return top;
}

/**
 * How much of his game a man has played before his pace is believed.
 *
 * Reading a whole game off a fraction q of one has about 1/q the
 * variance a whole game has, so (1 - q) / q of invented spread goes into
 * the system as observation noise and the evidence is discounted by it.
 * Under a tenth played that would divide by almost nothing, and one
 * touchdown in the first two minutes would move everybody's odds, so the
 * fraction is floored here instead.
 */
const BARELY_PLAYED = 0.1;

const noiseAt = (played: number) =>
  (1 - played) / Math.max(BARELY_PLAYED, played);

/** how far out a pace is read, since a quantile of nought has no normal */
const FURTHEST = 0.002;

interface Watching {
  mix: Mix;
  line: Line;
  state: GameState;
  /** how much of his game is behind him, where it is under way */
  played: number;
  /** the normal his pace so far corresponds to */
  z: number;
}

/**
 * This week's draws for a run of men, sharing the factors their games
 * share and conditioned on what has been scored already.
 *
 * A man yet to kick off draws off the prior factors. A man in a game
 * under way is evidence: what he is on pace for over a full game goes on
 * his own distribution, that quantile becomes a normal, and the factors
 * his game shares are drawn from their posterior given every such man in
 * that game. Two games share no factor, so each is solved on its own.
 *
 * His own noise is partly observed too, so the rest of his own week is
 * shrunk towards what the pace implies, by the fraction played. That is
 * the simple treatment, and it leaves him unit variance.
 */
export function liveDraws(
  men: Starter[],
  rows: Map<string, SlateRow>,
  states: Map<string, GameState>,
  draws: number,
  lines?: Lines,
): Live {
  const top = topCatchers(rows);
  const watched = new Map<string, Watching>();

  for (const man of men) {
    const line = lineFor(man, rows, lines);

    if (!line || watched.has(man.key)) {
      continue;
    }

    const state = stateAt(line, states);
    const played = state.where === "in"
      ? Math.min(1, Math.max(0, 1 - state.left))
      : 0;
    const at = played > 0
      ? quantileOf(line.spread, (man.points ?? 0) / played)
      : 0.5;

    watched.set(man.key, {
      mix: mixFor(
        { key: man.key, position: line.position, team: line.team },
        line.opponent,
        THIS_WEEK,
        top.has(man.key),
      ),
      line,
      state,
      played,
      z: normalQuantile(
        Math.min(1 - FURTHEST, Math.max(FURTHEST, at))),
    });
  }

  const posterior = new Map<string, number[]>();
  const games = new Map<string, Watching[]>();

  for (const his of watched.values()) {
    if (his.played > 0) {
      const game = gameOf(his.line);
      games.set(game, [...(games.get(game) ?? []), his]);
    }
  }

  for (const [game, seen] of games) {
    const factors = factorsOf(seen.map((his) => his.mix));

    if (!factors.length) {
      continue;
    }

    const solved = posteriorFor(
      seen.map((his) => ({
        mix: his.mix, z: his.z, noise: noiseAt(his.played),
      })),
      factors,
    );

    for (const [name, its] of posteriorDraws(solved, factors, game, draws)) {
      posterior.set(name, its);
    }
  }

  const from: From = (seed, want) =>
    posterior.get(seed) ?? factorFor(seed, want);
  const kept = new Map<string, number[]>();

  const drawFor = (key: string): number[] => {
    const his = watched.get(key);

    if (!his || his.state.left <= 0) {
      return new Array(draws).fill(0) as number[];
    }

    const { played } = his;
    const left = factorFor(`${key}|left`, draws);
    const us = Array.from({ length: draws }, (_, i) => {
      let z = 0;

      for (const term of his.mix.terms) {
        z += term.load * from(term.factor, draws)[i]!;
      }

      if (played <= 0) {
        return normalCdf(z + his.mix.own * from(his.mix.ownSeed, draws)[i]!);
      }

      const implied = his.mix.own > 1e-9 ? (his.z - z) / his.mix.own : 0;
      const own = played * implied +
        Math.sqrt(Math.max(0, 1 - played * played)) * left[i]!;

      return normalCdf(z + his.mix.own * own);
    });
    const week = weeksFromSpread(his.line.spread, key, draws, us);

    return his.state.left >= 1
      ? week
      : week.map((points) => points * his.state.left);
  };

  return {
    draws,
    toCome(key) {
      let his = kept.get(key);

      if (!his) {
        his = drawFor(key);
        kept.set(key, his);
      }

      return his;
    },
  };
}

/** this week's draws, with every man's answered once and kept */
export interface Live {
  draws: number;
  /** what a man might still add to a side, draw by draw */
  toCome: (key: string) => number[];
}

/** everybody a matchup puts on the field or on the bench */
export const menOf = (matchup: Matchup) =>
  matchup.sides.flatMap((side) => [...side.starters, ...side.bench]);

/** what a side ends the week on, draw by draw */
export function sideTotals(
  side: Matchup["sides"][number],
  rows: Map<string, SlateRow>,
  states: Map<string, GameState>,
  draws: number,
  live?: Live,
  lines?: Lines,
): number[] {
  const drawn = live ??
    liveDraws([...side.starters, ...side.bench], rows, states, draws, lines);
  const totals = new Array(draws).fill(0) as number[];

  for (const starter of side.starters) {
    const toCome = drawn.toCome(starter.key);

    for (let i = 0; i < draws; i++) {
      totals[i] = totals[i]! + starter.points + toCome[i]!;
    }
  }

  return totals;
}

/** how many draws a live win chance is read off */
export const LIVE_DRAWS = 4000;

const mean = (its: number[]) =>
  its.reduce((sum, n) => sum + n, 0) / Math.max(1, its.length);

export interface Standing {
  /** how often each side wins it from here */
  odds: [number, number];
  /** and what each side finishes on, on average */
  projected: [number, number];
}

/** a matchup from here, both sides drawn against each other once */
export function standingFor(
  matchup: Matchup,
  rows: Map<string, SlateRow>,
  states: Map<string, GameState>,
  lines?: Lines,
  draws = LIVE_DRAWS,
): Standing {
  const live = liveDraws(menOf(matchup), rows, states, draws, lines);
  const home = sideTotals(matchup.sides[0], rows, states, draws, live);
  const away = sideTotals(matchup.sides[1], rows, states, draws, live);
  const p = winChance(home, away);

  return { odds: [p, 1 - p], projected: [mean(home), mean(away)] };
}

/** how often each side of a matchup wins it from here */
export function oddsFor(
  matchup: Matchup,
  rows: Map<string, SlateRow>,
  states: Map<string, GameState>,
  draws = LIVE_DRAWS,
  lines?: Lines,
): [number, number] {
  return standingFor(matchup, rows, states, lines, draws).odds;
}

export interface Swap {
  /** the bench man who goes in */
  starts: string;
  /** the starter who comes out */
  benches: string;
  slot: string;
  /** what the change is worth, as win chance */
  gains: number;
}

export interface Best {
  starters: Side["starters"];
  odds: number;
  swaps: Swap[];
}

/** a man nobody can move: his game has kicked off */
const locked = (
  man: Starter, rows: Map<string, SlateRow>, states: Map<string, GameState>,
  lines?: Lines,
) => starterState(man, rows, states, lines)?.where !== "pre";

/**
 * Whether this slot takes a man of that position. A slot nobody here
 * recognises is treated as a flex where the league has any, since that is
 * what an unusual slot name nearly always is.
 */
function takes(
  slot: string, position: string, slots: string[] | null | undefined,
): boolean {
  if (knownSlot(slot)) {
    return slotTakes(slot, position);
  }

  return lineupOf(slots).flex > 0 && FLEX_POSITIONS.includes(position);
}

/**
 * The lineup that beats this opponent most often, and what it takes to
 * get there from the one that is set.
 *
 * Every legal single swap is tried, the best one is taken, and that
 * repeats until none of them helps. Trying every lineup is out of reach,
 * and a swap that only pays alongside another swap is rare enough to
 * lose. Both lineups are drawn against the same opponent draws, so the
 * gap between them is the lineup and not the noise.
 */
export function bestLineupFor(
  side: Side,
  against: Side,
  slots: string[] | null | undefined,
  rows: Map<string, SlateRow>,
  states: Map<string, GameState>,
  draws = LIVE_DRAWS,
  lines?: Lines,
): Best {
  const live = liveDraws(
    [...side.starters, ...side.bench, ...against.starters, ...against.bench],
    rows, states, draws, lines,
  );
  const theirs = sideTotals(against, rows, states, draws, live);
  const benched = side.bench
    .map((man) => ({ man, line: lineOf(man.key, rows, lines) }))
    .filter((his) => his.line && !locked(his.man, rows, states, lines));
  const scoredBy = (man: { key: string; points: number }, i: number) =>
    man.points + live.toCome(man.key)[i]!;
  let starters = [...side.starters];
  let bench = benched.map((his) => his.man);
  const positionOf = (key: string) => lineOf(key, rows, lines)?.position;
  let totals = Array.from({ length: draws }, (_, i) =>
    starters.reduce((sum, man) => sum + scoredBy(man, i), 0));
  let odds = winChance(totals, theirs);
  const swaps: Swap[] = [];

  for (;;) {
    let found: { swap: Swap; totals: number[] } | null = null;

    for (const man of bench) {
      const position = positionOf(man.key);

      if (!position) {
        continue;
      }

      for (const starter of starters) {
        if (
          locked(starter, rows, states, lines) ||
          !takes(starter.slot, position, slots)
        ) {
          continue;
        }

        const swapped = totals.map((total, i) =>
          total - scoredBy(starter, i) + scoredBy(man, i));
        const gains = winChance(swapped, theirs) - odds;

        if (gains > (found?.swap.gains ?? 0)) {
          found = {
            swap: { starts: man.key, benches: starter.key, slot: starter.slot, gains },
            totals: swapped,
          };
        }
      }
    }

    if (!found) {
      return { starters, odds, swaps };
    }

    const { swap } = found;
    const out = starters.find((s) => s.key === swap.benches)!;
    starters = starters.map((s) =>
      s.key === swap.benches
        ? { key: swap.starts, slot: s.slot, points: bencher(bench, swap.starts) }
        : s);
    bench = [
      ...bench.filter((man) => man.key !== swap.starts),
      { key: out.key, points: out.points },
    ];
    totals = found.totals;
    odds += swap.gains;
    swaps.push(swap);
  }
}

const bencher = (bench: Side["bench"], key: string) =>
  bench.find((man) => man.key === key)?.points ?? 0;

/**
 * Where a starter's own game has got to, or null when nobody has a line
 * on him at all. Those two were the same answer once, and a kicker the
 * slate leaves out read as done with nought.
 */
export function starterState(
  starter: Starter,
  rows: Map<string, SlateRow>,
  states: Map<string, GameState>,
  lines?: Lines,
): GameState | null {
  const line = lineFor(starter, rows, lines);

  return line ? stateAt(line, states) : null;
}

/** what a man is projected to add from here, on top of what he has */
export const projectedFor = (
  key: string, rows: Map<string, SlateRow>, lines?: Lines, slot?: string,
) => lineFor({ key, slot }, rows, lines)?.blend ?? null;

/**
 * A name short enough for a phone: the first name cut to an initial. Only
 * the leading word goes, so a suffix or a two word surname survives.
 */
export function initialForm(name: string): string {
  const words = name.trim().split(/\s+/);
  const first = words[0];

  if (words.length < 2 || !first) {
    return name.trim();
  }

  return `${first[0]}. ${words.slice(1).join(" ")}`;
}

/** one bench man measured against the starter in a seat */
export interface Alternative {
  key: string;
  position: string;
  /** what starting him instead would do to the win chance */
  gains: number;
  /** his game has kicked off, so the league will not take the change */
  locked: boolean;
}

/** a seat, who is in it, and who else could be */
export interface SlotChoice {
  slot: string;
  starter: Side["starters"][number];
  /** the starter's own game has kicked off, so he cannot come out */
  locked: boolean;
  options: Alternative[];
}

/** how many draws the alternatives are read off, per seat and per man */
export const CHOICE_DRAWS = 2000;

/**
 * Every seat in your lineup with the bench men who could take it, each
 * with what starting him would do to your chance of winning this week.
 *
 * One set of draws serves the whole board, so every answer is measured
 * against the same opponent and the differences between them are the men
 * rather than the drawing.
 */
export function alternativesFor(
  side: Side,
  against: Side,
  slots: string[] | null | undefined,
  rows: Map<string, SlateRow>,
  states: Map<string, GameState>,
  draws = CHOICE_DRAWS,
  lines?: Lines,
): SlotChoice[] {
  const live = liveDraws(
    [...side.starters, ...side.bench, ...against.starters, ...against.bench],
    rows, states, draws, lines,
  );
  const theirs = sideTotals(against, rows, states, draws, live);
  const scoredBy = (man: Starter, i: number) =>
    (man.points ?? 0) + live.toCome(man.key)[i]!;
  const totals = Array.from({ length: draws }, (_, i) =>
    side.starters.reduce((sum, man) => sum + scoredBy(man, i), 0));
  const odds = winChance(totals, theirs);
  const benched = side.bench
    .map((man) => ({ man, line: lineOf(man.key, rows, lines) }))
    .filter((his) => his.line !== null);

  return side.starters.map((starter) => {
    const shut = locked(starter, rows, states, lines);
    const options = benched
      .filter((his) => takes(starter.slot, his.line!.position, slots))
      .map((his) => {
        const swapped = totals.map((total, i) =>
          total - scoredBy(starter, i) + scoredBy(his.man, i));

        return {
          key: his.man.key,
          position: his.line!.position,
          gains: winChance(swapped, theirs) - odds,
          locked: shut || locked(his.man, rows, states, lines),
        };
      })
      .sort((a, b) => b.gains - a.gains);

    return { slot: starter.slot, starter, locked: shut, options };
  });
}
