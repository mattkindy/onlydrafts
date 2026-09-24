/**
 * The week in review for one league: who won what, and which players beat
 * or missed their pregame numbers.
 *
 * The awards count only games where nobody is left to play, because a
 * side with three players still to come has not scored its week yet.
 * While any game is going the report says it is provisional and gives
 * what it has. A player is measured against his own spread, so forty
 * from a back projected twenty five and twenty from a receiver projected
 * ten land in the same terms. The best lineup a side could have started
 * is worked in points, not win chance, since the week is over and there
 * is nothing left to draw. A player nobody has a line on is left out of
 * both, which can only understate what a side left on its bench.
 */

import { PASS_CATCHERS } from "./copula.ts";
import {
  lineFor, lineOf, standingFor, starterState,
  type Lines, type GameState, type Line,
} from "./matchups.ts";
import type { Matchup, PlayerWeek, Side } from "./providers.ts";
import { scoredSays, slotTakes } from "./scoring.ts";
import type { SlateRow } from "./slate.ts";
import { quantileOf, type Spread } from "./spread.ts";

/** the positions the report splits its over and under performers by */
export const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];

/** what a league starts when it has not said, the same as the scoring does */
const DEFAULT_SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX"];

/** how many draws a pregame win chance is read off, once per game */
export const PREGAME_DRAWS = 800;

export type Award =
  | "highest" | "lowest" | "blowout" | "closest"
  | "lucky" | "unlucky" | "stolen" | "choke"
  | "beater" | "shortfall" | "bench" | "manager" | "swap";

export const AWARD_SAYS: Record<Award, string> = {
  highest: "top score",
  lowest: "low score",
  blowout: "blowout",
  closest: "nail biter",
  lucky: "lucky win",
  unlucky: "tough loss",
  stolen: "steal",
  choke: "choke",
  beater: "most over projection",
  shortfall: "most under projection",
  bench: "most points benched",
  manager: "best lineup call",
  swap: "worst lineup call",
};

/**
 * The ones given out, in the order the card reads them. A lucky win and a
 * tough loss say much what a steal and a choke do, and the best lineup
 * call is nearly always "nothing left on the bench", so those stay in
 * the picks and out of the card.
 */
export const AWARDS: Award[] = [
  "highest", "lowest", "blowout", "closest", "stolen", "choke",
  "beater", "bench", "swap",
];

export interface Superlative {
  award: Award;
  /** the team the award goes to */
  owner: string;
  /** the number it is given for */
  figure: string;
  /** what makes it the award, where the figure alone does not say */
  note: string | null;
  /** a share to fill a small bar with, where one says anything */
  fill?: number;
  /** whether the team it belongs to won, for the tick on that bar */
  won?: boolean;
}

/** one player's week, however he came by it */
export interface Scorer {
  key: string;
  name: string;
  position: string;
  /** the team that started him, or had him on the bench */
  owner: string;
  points: number;
}

/** one starter against his pregame line */
export interface PlayerNote extends Scorer {
  /** the middle of his pregame spread */
  line: number;
  /** and the whole of it, for the range bar drawn beside him */
  spread: Spread;
  /** where his points fall on that spread, 0 to 1 */
  quantile: number;
}

export interface PositionPick {
  position: string;
  over: PlayerNote | null;
  under: PlayerNote | null;
}

/** what one side scored, against the best it could have started */
export interface SideScore {
  owner: string;
  points: number;
  best: number;
  won: boolean;
}

/** a quarterback and one of his receivers, both over their lines */
export interface Stack {
  owner: string;
  /** the pro team the two of them play for */
  team: string;
  names: [string, string];
  points: number;
}

/** the best week nobody in the league had */
export interface FreeAgents {
  /** the league's own rates, or Sleeper's full points, whichever was used */
  scoredBy: "league" | "ppr";
  top: Scorer | null;
  positions: { position: string; top: Scorer | null }[];
}

/** everybody a manager started who scored nothing, with why where it is known */
export interface Zeroes {
  owner: string;
  names: string[];
}

export interface Report {
  league: string;
  week: number;
  games: number;
  /** how many of them have nobody left to play */
  finished: number;
  /** a game is still going, so the awards may yet change */
  provisional: boolean;
  /** the two the report leads with */
  player: PlayerNote | null;
  manager: Superlative | null;
  awards: Superlative[];
  /** every side's points, biggest first, with the league's middle */
  scores: SideScore[];
  median: number;
  positions: PositionPick[];
  /** the three biggest weeks against the line, and the three worst */
  best: PlayerNote[];
  worst: PlayerNote[];
  /** the highest scoring benched player at each position */
  benched: Scorer[];
  /** a starter who scored nothing at all, by the manager who started him */
  zeroes: Zeroes[];
  stack: Stack | null;
  freeAgents: FreeAgents | null;
}

/** how a game looked before anybody kicked off */
export interface Pregame {
  odds: [number, number];
  projected: [number, number];
}

export interface ReportInput {
  league: string;
  week: number;
  games: Matchup[];
  rows: Map<string, SlateRow>;
  states: Map<string, GameState>;
  /** the board in this league's terms, for the players the slate leaves out */
  lines?: Lines;
  /** the slots the league starts, for the lineup a side could have put out */
  slots?: string[] | null;
  /** each game as it looked pregame, in the order the games came in */
  pregame?: (Pregame | null)[];
  /** every player's week, for the free agents nobody started */
  weeks?: PlayerWeek[];
  /** the keys of every player somebody in the league has */
  rostered?: Set<string>;
}

type Starter = Side["starters"][number];

/** whatever anybody calls this player, and failing everybody his key */
const namedAs = (
  key: string, said: string | undefined, rows: Map<string, SlateRow>,
  lines?: Lines,
) => rows.get(key)?.name ?? lines?.get(key)?.name ?? said ?? key;

/** his own game has run out of clock, so what he has is what he gets */
function played(
  starter: Starter, rows: Map<string, SlateRow>,
  states: Map<string, GameState>, lines?: Lines,
): boolean {
  const state = starterState(starter, rows, states, lines);

  return !state || state.left <= 0;
}

const finishedGame = (
  game: Matchup, rows: Map<string, SlateRow>,
  states: Map<string, GameState>, lines?: Lines,
) => game.sides.every(
  (side) => side.starters.every((s) => played(s, rows, states, lines)));

/**
 * Every game as it looked before kickoff.
 *
 * Each team is put back to pre and each starter to no points. A side that
 * kept its points would read as a full week stacked on what it already has.
 */
export function pregameOf(
  games: Matchup[], rows: Map<string, SlateRow>, lines?: Lines,
  draws = PREGAME_DRAWS,
): Pregame[] {
  const before = new Map<string, GameState>();

  for (const game of games) {
    for (const side of game.sides) {
      for (const starter of side.starters) {
        const line = lineFor(starter, rows, lines);

        if (line?.team) {
          before.set(line.team, { where: "pre", left: 1 });
        }
      }
    }
  }

  return games.map((game) => {
    const { odds, projected } = standingFor(
      beforeKickoff(game), { rows, states: before, lines, draws });

    return { odds, projected };
  });
}

/** a side with nobody having scored yet */
const scoreless = (side: Side): Side => ({
  ...side,
  points: 0,
  starters: side.starters.map((starter) => ({ ...starter, points: 0 })),
  bench: side.bench.map((player) => ({ ...player, points: 0 })),
});

const beforeKickoff = (game: Matchup): Matchup => ({
  ...game,
  sides: [scoreless(game.sides[0]), scoreless(game.sides[1])],
});

/** a player in the pool a best lineup is picked from */
interface Scored {
  key: string;
  points: number;
  position: string;
}

const scoredOf = (
  key: string, points: number, line: Line | null,
): Scored | null => line ? { key, points, position: line.position } : null;

function poolOf(
  side: Side, rows: Map<string, SlateRow>, lines?: Lines,
): Scored[] {
  const starters = side.starters.map(
    (s) => scoredOf(s.key, s.points, lineFor(s, rows, lines)));
  const bench = side.bench.map(
    (s) => scoredOf(s.key, s.points, lineOf(s.key, rows, lines)));

  return [...starters, ...bench].filter((his): his is Scored => his !== null);
}

/** how many positions a slot would take, so the narrowest one picks first */
const takesCount = (slot: string) =>
  POSITIONS.filter((position) => slotTakes(slot, position)).length;

const slotsOf = (slots: string[] | null | undefined) =>
  (slots?.length ? slots : DEFAULT_SLOTS)
    .map((slot) => ({ slot, takes: takesCount(slot) }))
    .filter((its) => its.takes > 0)
    .sort((a, b) => a.takes - b.takes);

/**
 * The most points this side could have started.
 *
 * Slots are filled narrowest first, so a superflex is not spent on the
 * quarterback the quarterback slot needed.
 */
export function bestPointsFor(
  side: Side, slots: string[] | null | undefined,
  rows: Map<string, SlateRow>, lines?: Lines,
): number {
  const pool = poolOf(side, rows, lines).sort((a, b) => b.points - a.points);
  const taken = new Set<string>();
  let total = 0;

  for (const { slot } of slotsOf(slots)) {
    const his = pool.find(
      (p) => !taken.has(p.key) && slotTakes(slot, p.position));

    if (!his) {
      continue;
    }

    taken.add(his.key);
    total += his.points;
  }

  return total;
}

/** the one change that would have won the game */
export interface Swap {
  starts: string;
  benches: string;
  /** what the side would have won by after it */
  by: number;
}

/**
 * The single swap that turns this loss into a win, where there is one.
 *
 * Only the slot a bench player could have filled counts, so a kicker
 * standing in for a running back is not offered, and the best of them is
 * the one that wins by most.
 */
export function winningSwapOf(
  side: Side, against: number, slots: string[] | null | undefined,
  rows: Map<string, SlateRow>, lines?: Lines,
): Swap | null {
  const bench = side.bench
    .map((b) => ({ b, line: lineOf(b.key, rows, lines) }))
    .filter((his): his is { b: Side["bench"][number]; line: Line } =>
      his.line !== null);
  let best: Swap | null = null;

  for (const { b, line } of bench) {
    for (const starter of side.starters) {
      if (!slotTakes(starter.slot, line.position)) {
        continue;
      }

      const by = side.points - starter.points + b.points - against;

      if (by > 0 && (!best || by > best.by)) {
        best = {
          starts: namedAs(b.key, b.name, rows, lines),
          benches: namedAs(starter.key, starter.name, rows, lines),
          by,
        };
      }
    }
  }

  return best;
}

/** one side of one finished game, in the terms the awards are read off */
interface SideLine {
  owner: string;
  points: number;
  against: string;
  /** what he won by, negative when he lost */
  margin: number;
  /** the most he could have started, and how much of it he left out */
  best: number;
  left: number;
  /** how often he was winning this before kickoff, where that is known */
  chance: number | null;
  /** what he was projected to score, and what he beat it by */
  expected: number | null;
  over: number | null;
  swap: Swap | null;
}

function sideLinesOf(input: ReportInput): SideLine[] {
  const out: SideLine[] = [];

  for (const [at, game] of input.games.entries()) {
    if (!finishedGame(game, input.rows, input.states, input.lines)) {
      continue;
    }

    const pregame = input.pregame?.[at] ?? null;

    for (const which of [0, 1] as const) {
      const side = game.sides[which];
      const other = game.sides[1 - which]!;
      const best = bestPointsFor(side, input.slots, input.rows, input.lines);
      const expected = pregame?.projected[which] ?? null;
      const margin = side.points - other.points;

      out.push({
        owner: side.owner,
        points: side.points,
        against: other.owner,
        margin,
        best,
        left: Math.max(0, best - side.points),
        chance: pregame?.odds[which] ?? null,
        expected,
        over: expected === null ? null : side.points - expected,
        swap: margin < 0
          ? winningSwapOf(
            side, other.points, input.slots, input.rows, input.lines)
          : null,
      });
    }
  }

  return out;
}

/** the entry the scoring function likes most, or null when there are none */
function pickBy<T>(its: T[], score: (it: T) => number): T | null {
  let best: T | null = null;
  let mark = -Infinity;

  for (const it of its) {
    const at = score(it);

    if (at > mark) {
      best = it;
      mark = at;
    }
  }

  return best;
}

const won = (side: SideLine) => side.margin > 0;

const lost = (side: SideLine) => side.margin < 0;

const beat = (side: SideLine) =>
  `beat ${side.against} by ${scoredSays(side.margin)}`;

const asPct = (share: number) => Math.round(share * 100) + "%";

/** the sides whose pregame chance is known, which the two upsets need */
const withChance = (sides: SideLine[]) =>
  sides.filter((side): side is SideLine & { chance: number } =>
    side.chance !== null);

const withProjection = (sides: SideLine[]) =>
  sides.filter((side): side is SideLine & { over: number; expected: number } =>
    side.over !== null && side.expected !== null);

/** how each award is chosen and what it says, one entry a piece */
const AWARD_PICKS: Record<Award, (sides: SideLine[]) => Superlative | null> = {
  highest: (sides) => {
    const top = pickBy(sides, (s) => s.points);

    return top && {
      award: "highest", owner: top.owner, figure: scoredSays(top.points),
      note: `vs ${top.against}`,
    };
  },
  lowest: (sides) => {
    const low = pickBy(sides, (s) => -s.points);

    return low && {
      award: "lowest", owner: low.owner, figure: scoredSays(low.points),
      note: `vs ${low.against}`,
    };
  },
  blowout: (sides) => {
    const big = pickBy(sides.filter(won), (s) => s.margin);

    return big && {
      award: "blowout", owner: big.owner, figure: scoredSays(big.margin),
      note: beat(big),
    };
  },
  closest: (sides) => {
    const tight = pickBy(sides.filter((s) => !lost(s)), (s) => -s.margin);

    return tight && {
      award: "closest", owner: tight.owner,
      figure: scoredSays(Math.abs(tight.margin)),
      note: won(tight) ? beat(tight) : `tied with ${tight.against}`,
    };
  },
  lucky: (sides) => {
    const fortunate = pickBy(sides.filter(won), (s) => -s.points);

    return fortunate && {
      award: "lucky", owner: fortunate.owner,
      figure: scoredSays(fortunate.points),
      note: beat(fortunate),
    };
  },
  unlucky: (sides) => {
    const robbed = pickBy(sides.filter(lost), (s) => s.points);

    return robbed && {
      award: "unlucky", owner: robbed.owner,
      figure: scoredSays(robbed.points),
      note: `lost to ${robbed.against} by ${scoredSays(-robbed.margin)}`,
    };
  },
  stolen: (sides) => {
    const thief = pickBy(withChance(sides).filter(won), (s) => -s.chance);

    // a favourite winning has stolen nothing
    if (!thief || thief.chance >= 0.5) {
      return null;
    }

    return {
      award: "stolen", owner: thief.owner, figure: asPct(thief.chance),
      note: `${asPct(thief.chance)} to win, ${beat(thief)}`,
      fill: thief.chance,
      won: true,
    };
  },
  choke: (sides) => {
    const gone = pickBy(withChance(sides).filter(lost), (s) => s.chance);

    if (!gone || gone.chance <= 0.5) {
      return null;
    }

    return {
      award: "choke", owner: gone.owner, figure: asPct(gone.chance),
      note: `${asPct(gone.chance)} to win, lost to ${gone.against}`,
      fill: gone.chance,
      won: false,
    };
  },
  beater: (sides) => {
    const over = pickBy(withProjection(sides), (s) => s.over);

    return over && over.over > 0
      ? {
        award: "beater", owner: over.owner,
        figure: "+" + scoredSays(over.over),
        note: `${scoredSays(over.points)}, projected ${scoredSays(over.expected)}`,
      }
      : null;
  },
  shortfall: (sides) => {
    const under = pickBy(withProjection(sides), (s) => -s.over);

    return under && under.over < 0
      ? {
        award: "shortfall", owner: under.owner,
        figure: scoredSays(under.over),
        note: `${scoredSays(under.points)}, projected ${scoredSays(under.expected)}`,
      }
      : null;
  },
  bench: (sides) => {
    const waster = pickBy(sides, (s) => s.left);

    if (!waster || waster.left <= 0) {
      return null;
    }

    return {
      award: "bench", owner: waster.owner, figure: scoredSays(waster.left),
      // the scores strip already draws what every side left out
      note: `could have had ${scoredSays(waster.best)}`,
    };
  },
  manager: (sides) => {
    const sharp = pickBy(sides, (s) => -s.left);

    return sharp && {
      award: "manager", owner: sharp.owner, figure: scoredSays(sharp.left),
      note: sharp.left <= 0
        ? "nothing left on the bench"
        : `could have had ${scoredSays(sharp.best)}`,
    };
  },
  swap: (sides) => {
    const had = sides.filter(
      (side): side is SideLine & { swap: Swap } => side.swap !== null);
    const worst = pickBy(had, (s) => s.swap.by);

    return worst && {
      award: "swap", owner: worst.owner, figure: scoredSays(worst.swap.by),
      note: `${worst.swap.starts} over ${worst.swap.benches} wins it`,
    };
  },
};

function awardsOf(sides: SideLine[]): Superlative[] {
  const out: Superlative[] = [];

  for (const award of AWARDS) {
    const given = AWARD_PICKS[award](sides);

    if (given) {
      out.push(given);
    }
  }

  return out;
}

const scoresOf = (sides: SideLine[]): SideScore[] =>
  sides
    .map((side) => ({
      owner: side.owner, points: side.points, best: side.best,
      won: side.margin > 0,
    }))
    .sort((a, b) => b.points - a.points);

/** the middle of the week, for the line down the scores strip */
function medianOf(scores: SideScore[]): number {
  if (!scores.length) {
    return 0;
  }

  const points = scores.map((s) => s.points).sort((a, b) => a - b);
  const at = Math.floor(points.length / 2);

  if (points.length % 2) {
    return points[at]!;
  }

  return (points[at - 1]! + points[at]!) / 2;
}

const noteOf = (
  starter: Starter, owner: string, line: Line, input: ReportInput,
): PlayerNote => ({
  key: starter.key,
  name: namedAs(starter.key, starter.name, input.rows, input.lines),
  position: line.position,
  owner,
  points: starter.points ?? 0,
  line: line.blend,
  spread: line.spread,
  quantile: quantileOf(line.spread, starter.points ?? 0),
});

/** every starter in the league whose game is over, against his own spread */
function notesOf(input: ReportInput): PlayerNote[] {
  const out: PlayerNote[] = [];

  for (const game of input.games) {
    for (const side of game.sides) {
      for (const starter of side.starters) {
        const line = lineFor(starter, input.rows, input.lines);

        if (!line || !played(starter, input.rows, input.states, input.lines)) {
          continue;
        }

        out.push(noteOf(starter, side.owner, line, input));
      }
    }
  }

  // a tie on the quantile breaks by name, so the same week reads the same
  // way twice
  return out.sort((a, b) =>
    b.quantile - a.quantile || a.name.localeCompare(b.name));
}

const positionsOf = (notes: PlayerNote[]): PositionPick[] =>
  POSITIONS.map((position) => {
    const his = notes.filter((note) => note.position === position);

    return {
      position,
      over: his[0] ?? null,
      under: his.length > 1 ? his[his.length - 1] ?? null : null,
    };
  });

/** the highest scoring benched player at each position */
function benchedOf(input: ReportInput): Scorer[] {
  const all: Scorer[] = [];

  for (const game of input.games) {
    for (const side of game.sides) {
      for (const player of side.bench) {
        const line = lineOf(player.key, input.rows, input.lines);

        if (!line) {
          continue;
        }

        all.push({
          key: player.key,
          name: namedAs(player.key, player.name, input.rows, input.lines),
          position: line.position,
          owner: side.owner,
          points: player.points,
        });
      }
    }
  }

  return POSITIONS
    .map((position) => pickBy(
      all.filter((his) => his.position === position), (his) => his.points))
    .filter((his): his is Scorer => his !== null && his.points > 0);
}

/** under a point, which for a starter is the same as not having played */
const ZERO = 1;

function zeroesOf(input: ReportInput): Zeroes[] {
  const by = new Map<string, string[]>();

  for (const game of input.games) {
    for (const side of game.sides) {
      for (const starter of side.starters) {
        const line = lineFor(starter, input.rows, input.lines);
        const over = played(starter, input.rows, input.states, input.lines);

        if (starter.points >= ZERO || (line && !over)) {
          continue;
        }

        by.set(side.owner, [
          ...by.get(side.owner) ?? [],
          namedAs(starter.key, starter.name, input.rows, input.lines),
        ]);
      }
    }
  }

  return [...by.entries()]
    .map(([owner, names]) => ({ owner, names }))
    .sort((a, b) => b.names.length - a.names.length);
}

/** a quarterback and one of his own receivers, both over their lines */
function stackOf(notes: PlayerNote[], input: ReportInput): Stack | null {
  const over = notes.filter(
    (note) => note.points > note.line && teamOf(note, input));
  let best: Stack | null = null;

  for (const passer of over.filter((note) => note.position === "QB")) {
    const team = teamOf(passer, input);

    for (const catcher of over) {
      if (
        catcher.owner !== passer.owner ||
        !PASS_CATCHERS.includes(catcher.position) ||
        teamOf(catcher, input) !== team
      ) {
        continue;
      }

      const points = passer.points + catcher.points;

      if (!best || points > best.points) {
        best = {
          owner: passer.owner,
          team: team ?? "",
          names: [passer.name, catcher.name],
          points,
        };
      }
    }
  }

  return best;
}

const teamOf = (note: PlayerNote, input: ReportInput) =>
  lineOf(note.key, input.rows, input.lines)?.team ?? null;

/** the best week nobody in the league had, overall and by position */
function freeAgentsOf(input: ReportInput): FreeAgents | null {
  const weeks = input.weeks;

  if (!weeks?.length) {
    return null;
  }

  const rostered = input.rostered ?? new Set<string>();
  const loose = weeks
    .filter((his) => !rostered.has(his.key) && his.points > 0)
    .map((his): Scorer => ({
      key: his.key,
      name: his.name,
      position: his.position,
      // nobody had him, which is the whole point of the section
      owner: "",
      points: his.points,
    }));

  return {
    scoredBy: weeks[0]!.scoredBy,
    top: pickBy(loose, (his) => his.points),
    positions: POSITIONS.map((position) => ({
      position,
      top: pickBy(
        loose.filter((his) => his.position === position), (his) => his.points),
    })),
  };
}

/** past this far into either tail, a percentile stops saying much */
const TAIL = 0.05;

/**
 * The tail past the 90th is a normal fitted to the top of the spread,
 * so the odds it gives a monster week are a model's, and get silly fast.
 * A million is where they stop.
 */
const LONGEST_ODDS = 1_000_000;

/** one in so many, to two figures, with commas */
function oneIn(share: number): string {
  const n = Math.min(LONGEST_ODDS, 1 / Math.max(share, 1e-12));
  const digits = 10 ** Math.max(0, Math.floor(Math.log10(n)) - 1);
  const rounded = Math.round(n / digits) * digits;

  return "1 in " + rounded.toLocaleString("en-US");
}

/**
 * Where a week's points fall on his spread. Inside the spread it is a
 * percentile, and out in either tail it is the odds of a week that far
 * out, which says more about a 40 point week than "99th" does.
 */
export function quantileSays(quantile: number): string {
  const tail = Math.min(quantile, 1 - quantile);

  if (tail < TAIL) {
    return oneIn(tail) + (quantile > 0.5 ? " good" : " bad");
  }

  const at = Math.round(quantile * 100);
  const last = at % 10;
  const teens = at > 10 && at < 20;
  const ends = teens ? "th" : ["th", "st", "nd", "rd"][last] ?? "th";

  return at + ends + " pct";
}

/** what one player's week reads as next to his line */
export const noteSays = (note: PlayerNote) =>
  `${scoredSays(note.points)} line ${note.line.toFixed(1)}, ` +
  quantileSays(note.quantile);

export function reportFor(input: ReportInput): Report {
  const sides = sideLinesOf(input);
  const notes = notesOf(input);
  const finished = sides.length / 2;
  const best = notes.slice(0, 3);
  const awards = awardsOf(sides);
  const scores = scoresOf(sides);

  return {
    league: input.league,
    week: input.week,
    games: input.games.length,
    finished,
    provisional: finished < input.games.length,
    player: best[0] ?? null,
    manager: awards.find((given) => given.award === "beater") ?? null,
    awards,
    scores,
    median: medianOf(scores),
    positions: positionsOf(notes),
    best,
    // the same player cannot be both, which a short week would otherwise do
    worst: notes.slice(-3).reverse().filter((note) => !best.includes(note)),
    benched: benchedOf(input),
    zeroes: zeroesOf(input),
    stack: stackOf(notes, input),
    freeAgents: freeAgentsOf(input),
  };
}
