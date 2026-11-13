/**
 * Standing at the end of week W, how well does each way of reading a
 * player predict what he averages from week W plus 1 to week 18?
 *
 * The readers are marked at the same cuts on the same players: the
 * preseason anchor the board ships now, his points a game so far, the
 * update, the update with one part switched off, and a reader who knew
 * the answer. Every fit is trained on seasons before the one predicted.
 *
 * Then the error again by which way his snap share has just moved, down,
 * steady or up, beside the shipped break and three ways of reading a drop
 * apart from a rise, so a shrinking role can be checked on its own.
 *
 * Run: npx tsx scripts/inSeasonLevelEval.ts
 */

import { loadGames } from "../src/data/nflverse.js";
import {
  loadSleeperWeekly, projectionKey, sleeperPointsUnder,
} from "../src/data/sleeperProjections.js";
import { scoring } from "../src/scoring/active.js";
import {
  readPlayedWeeks,
  roleRowsFrom,
  SHIPPED_SHAPE,
} from "../src/features/inSeasonBoard.js";
import {
  buildSeasonData,
  examplesForTransition,
  fitSeasonModel,
  predictSeasonBlend,
} from "../src/features/seasonModel.js";
import {
  fitRookieModel,
  predictRookie,
  rookiesFor,
} from "../src/features/rookies.js";
import {
  fitInSeasonUpdate,
  fitUpdateShape,
  updateLevel,
  type InSeasonFit,
  type PlayedWeek,
  type RiseRead,
  type RiseReason,
  type RoleLevelRow,
  type UpdateCase,
  type UpdateShape,
} from "../src/features/inSeasonLevel.js";
import {
  readRise,
  readRooms,
  type ReadRise,
  type RiseDetail,
  type Rooms,
} from "../src/features/riseReason.js";

const FIRST_DATA = 2015;
/** the first season a transition can be built for */
const FIRST_ANCHOR = 2017;
/** the first season with an earlier transition to fit an anchor on */
const FIRST_BOARD = 2018;
const LAST_PLAYED = 2025;
/** the season the board is on now, which has only a few weeks in it */
const LIVE = 2026;
const MARKED = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
const CUTS = [2, 4, 6, 8, 10];
const POSITIONS = new Set(["QB", "RB", "WR", "TE"]);
/** games after the cut a player needs before his average means anything */
const MIN_REST_GAMES = 3;
/** the share of players counted as having a changed role */
const SURPRISE_SHARE = 0.25;

interface Anchor {
  ppg: number;
  position: string;
  name: string;
}

interface Season {
  anchors: Map<string, Anchor>;
  weeks: Map<string, PlayedWeek[]>;
  roleRows: RoleLevelRow[];
  /** the rosters a rise is read off, for the seasons that are marked */
  rooms?: Rooms;
}

function seasons(from: number, to: number): number[] {
  const all: number[] = [];

  for (let s = from; s <= to; s++) {
    all.push(s);
  }

  return all;
}

type Rookies = Awaited<ReturnType<typeof rookiesFor>>;
type Examples = Awaited<ReturnType<typeof examplesForTransition>>;

interface Prior {
  examples: Map<number, Examples>;
  /** first year players only, which is what the rookie fit is trained on */
  rookies: Map<number, Rookies>;
  /** those plus anyone the board has no season to read, for predicting */
  unread: Map<number, Rookies>;
}

function anchorsFor(season: number, prior: Prior): Map<string, Anchor> {
  const train: Examples = [];
  const rookieTrain: Rookies = [];

  for (const year of seasons(FIRST_ANCHOR, season - 1)) {
    train.push(...prior.examples.get(year)!);
    rookieTrain.push(...prior.rookies.get(year)!);
  }

  const fit = fitSeasonModel(train);
  const rookieWeights = fitRookieModel(rookieTrain);
  const anchors = new Map<string, Anchor>();

  for (const e of prior.examples.get(season)!) {
    if (!POSITIONS.has(e.position)) {
      continue;
    }

    anchors.set(e.playerId, {
      ppg: predictSeasonBlend(fit, e),
      position: e.position,
      name: e.playerName ?? e.playerId,
    });
  }

  for (const r of prior.unread.get(season)!) {
    if (anchors.has(r.playerId) || !POSITIONS.has(r.position)) {
      continue;
    }

    anchors.set(r.playerId, {
      ppg: predictRookie(rookieWeights, r),
      position: r.position,
      name: r.name,
    });
  }

  return anchors;
}

interface Row extends UpdateCase {
  playerId: string;
  name: string;
  season: number;
  cut: number;
  toDatePpg: number;
}

function rowsAt(season: Season, year: number, cut: number): Row[] {
  const rows: Row[] = [];

  for (const [playerId, anchor] of season.anchors) {
    const his = season.weeks.get(playerId) ?? [];
    const before = his.filter((w) => w.week <= cut);
    const after = his.filter((w) => w.week > cut);

    if (before.length === 0 || after.length < MIN_REST_GAMES) {
      continue;
    }

    rows.push({
      playerId,
      name: anchor.name,
      season: year,
      cut,
      position: anchor.position,
      anchor: anchor.ppg,
      weeks: before,
      restPpg: after.reduce((sum, w) => sum + w.points, 0) / after.length,
      toDatePpg: before.reduce((sum, w) => sum + w.points, 0) / before.length,
    });
  }

  return rows;
}

function mae(said: number[], was: number[]): number {
  return said.reduce((s, p, i) => s + Math.abs(p - was[i]!), 0) / said.length;
}

function correlation(a: number[], b: number[]): number {
  const n = a.length;
  const meanA = a.reduce((s, x) => s + x, 0) / n;
  const meanB = b.reduce((s, x) => s + x, 0) / n;
  let together = 0;
  let spreadA = 0;
  let spreadB = 0;

  for (let i = 0; i < n; i++) {
    together += (a[i]! - meanA) * (b[i]! - meanB);
    spreadA += (a[i]! - meanA) ** 2;
    spreadB += (b[i]! - meanB) ** 2;
  }

  return together / Math.sqrt(spreadA * spreadB);
}

interface Marked {
  cut: number;
  was: number[];
  said: Record<string, number[]>;
  surprise: boolean[];
  /** how far his snap share moved over his last three games, null under four */
  move: (number | null)[];
  /** who each row is, so a bootstrap can draw whole players */
  who: string[];
  season: number[];
  /** why his snaps went up, where they went up in one of his last three */
  rise: (ReadRise | undefined)[];
}

/** games at the end of the window a move is read over, as the break reads it */
const MOVE_WINDOW = 3;

/**
 * His snap share over his last three games less what it was over the
 * games before them, the same reading the break takes. A player with
 * three games or fewer has nothing before to read it against.
 */
function snapMove(weeks: PlayedWeek[]): number | null {
  if (weeks.length <= MOVE_WINDOW) {
    return null;
  }

  const mean = (some: PlayedWeek[]) =>
    some.reduce((sum, w) => sum + w.snapShare, 0) / some.length;

  return mean(weeks.slice(-MOVE_WINDOW)) - mean(weeks.slice(0, -MOVE_WINDOW));
}

/** the directions a move is split by, nested the way the question was asked */
const MOVES: [string, (move: number | null) => boolean][] = [
  ["dropped .20 or more", (m) => m !== null && m <= -0.2],
  ["dropped .15 or more", (m) => m !== null && m <= -0.15],
  ["steady, inside .15", (m) => m !== null && Math.abs(m) < 0.15],
  ["rose .15 or more", (m) => m !== null && m >= 0.15],
  ["rose .20 or more", (m) => m !== null && m >= 0.2],
  ["three games or fewer", (m) => m === null],
];

/**
 * The update's error by which way his snaps have just moved, signed as
 * said less what happened, so a positive number is a player held above
 * what he went on to do. Every cut is pooled, since a drop of twenty
 * points is rare enough that one cut alone is a handful of players.
 */
function reportMoves(marked: Marked[], readers: string[], over: string): void {
  reportSplit(
    marked, readers,
    `by the move in his snap share over his last three games, ${over}`,
    MOVES.map(([label, keep]) => [label, (at, i) => keep(at.move[i]!)]),
  );
}

/** which rows a line of a split table counts */
type Keep = (at: Marked, i: number) => boolean;

/** signed error and MAE for each reader over each set of rows, pooled */
function reportSplit(
  marked: Marked[], readers: string[], title: string, splits: [string, Keep][],
  /** short names for the columns, and how wide each is */
  heads: { name: (reader: string) => string; column: number } =
    { name: (r) => r.slice(0, 26), column: 28 },
): void {
  const width = Math.max(24, ...splits.map(([label]) => label.length + 2));

  console.log(
    `\n${title}: players, then signed error (said less was) and MAE`,
  );
  console.log(
    "".padEnd(width) + "n     " +
      readers.map((r) => heads.name(r).padEnd(heads.column)).join(""),
  );

  for (const [label, keep] of splits) {
    let n = 0;
    const signed = readers.map(() => 0);
    const absolute = readers.map(() => 0);

    for (const at of marked) {
      at.was.forEach((was, i) => {
        if (!keep(at, i)) {
          return;
        }

        n++;
        readers.forEach((reader, r) => {
          const error = at.said[reader]![i]! - was;
          signed[r]! += error;
          absolute[r]! += Math.abs(error);
        });
      });
    }

    console.log(
      label.padEnd(width) + String(n).padEnd(6) + readers.map((_, r) =>
        (`${(signed[r]! / Math.max(1, n)).toFixed(3).padStart(7)} ` +
          `${(absolute[r]! / Math.max(1, n)).toFixed(3)}`).padEnd(heads.column)).join(""),
    );
  }
}

/** a run of draws that comes out the same every time the bench runs */
function seeded(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DRAWS = 2000;

/**
 * The difference in MAE between two readers on the same rows, a less b,
 * and its standard error by a paired bootstrap that draws whole players:
 * one man is in the pool at every cut of a season and in several seasons,
 * and his errors at those are not separate pieces of evidence.
 */
function pairedDifference(
  marked: Marked[], a: string, b: string, keep: Keep, draws = DRAWS,
): { diff: number; se: number; rows: number; players: number } {
  const byPlayer = new Map<string, { sum: number; n: number }>();

  for (const at of marked) {
    at.was.forEach((was, i) => {
      if (!keep(at, i)) {
        return;
      }

      const his = byPlayer.get(at.who[i]!) ?? { sum: 0, n: 0 };
      his.sum += Math.abs(at.said[a]![i]! - was) - Math.abs(at.said[b]![i]! - was);
      his.n++;
      byPlayer.set(at.who[i]!, his);
    });
  }

  const units = [...byPlayer.values()];
  const rows = units.reduce((s, u) => s + u.n, 0);
  const diff = units.reduce((s, u) => s + u.sum, 0) / Math.max(1, rows);
  const draw = seeded(20261113);
  const means: number[] = [];

  for (let d = 0; d < draws; d++) {
    let sum = 0;
    let n = 0;

    for (let k = 0; k < units.length; k++) {
      const unit = units[Math.floor(draw() * units.length)]!;
      sum += unit.sum;
      n += unit.n;
    }

    means.push(sum / Math.max(1, n));
  }

  const centre = means.reduce((s, m) => s + m, 0) / Math.max(1, means.length);
  const se = Math.sqrt(
    means.reduce((s, m) => s + (m - centre) ** 2, 0) / Math.max(1, means.length - 1));

  return { diff, se, rows, players: units.length };
}

const UPDATE = "the update";
const ABLATIONS = {
  "no role term": { roleCap: 0 },
  "role term only": { pointsCap: 0 },
  "no recency, no break": { decay: 1, breakGap: Infinity },
} as const;

/**
 * The constant the build ships, marked here for reference rather than
 * as a rival: it was fitted over every season including the ones it is
 * scored on, so its number is in sample and flatters itself.
 */
const SHIPPED = "shipped shape, in sample";
/** the same constant reading a rise at .30, held two games */
const SHIPPED_WARY = "shipped, rise .30 held, in sample";
const WARY_RISE = { breakGap: 0.3, dropGap: 0.2, riseHeld: true } as const;

/**
 * The update with a drop in snap share read apart from a rise: its own
 * break gap, searched over the same values, and the same with the drop
 * counted only where two of the last three games are that far down. Each
 * is fitted on the seasons before the one it marks, like the update.
 */
const DROPS = {
  "a drop's own gap": { apart: true },
  "a drop's own gap, held": { apart: true, held: true },
} as const;

/**
 * The break the build ships, twenty points either way, with the weights
 * fitted on earlier seasons the way the update's are. The update's own
 * search never picks that break, so this is what the shipped constant
 * looks like out of sample.
 */
const ONE_GAP = "one gap at .20, either way";

/**
 * The same on the one gap's own weights with a rise left unbroken, so
 * the only thing that differs from it is that a rise no longer breaks.
 * Refitting the weights instead moves the whole pool by up to a
 * hundredth on its own, which is week 2 differing where no break can
 * happen at all.
 */
const DROP_ONLY = "a drop at .20, a rise not";

/**
 * A rise read more warily than a drop, on the one gap's own weights so
 * the rise is the only thing that differs: breaking at a wider move, or
 * only once two of the last three games are that far up, or both. A man
 * filling in for a hurt starter has one big game and hands the job back.
 */
const RISES = {
  "a rise at .25": { breakGap: 0.25, dropGap: 0.2 },
  "a rise at .30": { breakGap: 0.3, dropGap: 0.2 },
  "a rise held two games": { breakGap: 0.2, dropGap: 0.2, riseHeld: true },
  "a rise at .30, held": { breakGap: 0.3, dropGap: 0.2, riseHeld: true },
} as const;

/** the wary rise the build ships, on the one gap's own weights */
const WARY = "a rise at .30, held";

const AT_ONCE: RiseRead = { games: "since" };
const WHOLE: RiseRead = { games: "whole" };
const AT_TWENTY: RiseRead = { games: "break", gap: 0.2, held: false };

/**
 * A rise read by why his snaps went up, which `riseReason.ts` reads off
 * his club's roster at the cut: the teammate at his position who lost
 * the snaps gone for long, out short term or back, or nobody missing.
 * Each is laid over the wary rise, so a reason with no entry, and a man
 * whose club does not say, is read as the wary rise reads him. "At once"
 * keeps only the games from the first he rose in, however few.
 */
const WHY: Record<string, Partial<Record<RiseReason, RiseRead>>> = {
  "why A: promotion at once, fill-in whole": { promotion: AT_ONCE, "fill-in": WHOLE },
  "why B: promotion at .20, fill-in whole": { promotion: AT_TWENTY, "fill-in": WHOLE },
  "why C: A, a depth change at once": {
    promotion: AT_ONCE, "fill-in": WHOLE, depth: AT_ONCE,
  },
  "why D: A, a depth change at .20": {
    promotion: AT_ONCE, "fill-in": WHOLE, depth: AT_TWENTY,
  },
  "why E: A, fill-in on games before": {
    promotion: AT_ONCE, "fill-in": { games: "before" },
  },
  "why F: A, fill-in half to anchor": {
    promotion: AT_ONCE, "fill-in": { games: "whole", toward: 0.5 },
  },
  "why G: a promotion at once alone": { promotion: AT_ONCE },
  "why H: a fill-in whole alone": { "fill-in": WHOLE },
  "why I: a depth change at .20 alone": { depth: AT_TWENTY },
  "why J: fill-in whole, depth at .20": { "fill-in": WHOLE, depth: AT_TWENTY },
  "why K: fill-in whole, depth at once": { "fill-in": WHOLE, depth: AT_ONCE },
  "why L: J, a promotion whole": {
    promotion: WHOLE, "fill-in": WHOLE, depth: AT_TWENTY,
  },
  "why M: J, a depth change at .25": {
    "fill-in": WHOLE, depth: { games: "break", gap: 0.25, held: false },
  },
  "why N: J, a depth change held": {
    "fill-in": WHOLE, depth: { games: "break", gap: 0.2, held: true },
  },
};

/** the letter each reading of a rise by its reason goes by in the wide tables */
const tagOf = (reader: string) => /^why ([A-Z]):/.exec(reader)?.[1] ?? reader;

/** the same laid over the shipped constant, so in sample like it */
const inSample = (label: string) => `${label}, in sample`;

const READERS = [
  "preseason anchor",
  "season to date",
  UPDATE,
  ...Object.keys(ABLATIONS),
  ONE_GAP,
  DROP_ONLY,
  ...Object.keys(RISES),
  ...Object.keys(DROPS),
  ...Object.keys(WHY),
  SHIPPED,
  SHIPPED_WARY,
  ...Object.keys(WHY).map(inSample),
  "oracle",
];

const rose20: Keep = (at, i) => at.move[i] !== null && at.move[i]! >= 0.2;
const roseAGame: Keep = (at, i) => at.rise[i] !== undefined;
const everyRow: Keep = () => true;

const REASONS: [RiseReason, RiseDetail[]][] = [
  ["promotion", ["reserve list", "released", "traded"]],
  ["fill-in", ["listed", "short reserve", "back"]],
  ["depth", ["playing less", "benched", "nobody lost them"]],
];

/** a pool split by the reason his snaps rose, then by the finer reading */
function byReason(pool: Keep, poolLabel: string): [string, Keep][] {
  const splits: [string, Keep][] = [[poolLabel, pool]];

  for (const [reason, details] of REASONS) {
    splits.push([`  ${reason}`, (at, i) => pool(at, i) && at.rise[i]?.reason === reason]);

    for (const detail of details) {
      splits.push([`    ${detail}`, (at, i) => pool(at, i) && at.rise[i]?.detail === detail]);
    }
  }

  splits.push(["  no roster to read", (at, i) => pool(at, i) && at.rise[i] === undefined]);

  return splits;
}

/**
 * Each reading of a rise by its reason against the wary rise it is laid
 * over: out of sample on the one gap's weights, and in sample on the
 * shipped constant. The whole pool cut by cut, the error by the move in
 * his snaps, the rises split by reason, and the difference with a paired
 * bootstrap's standard error.
 */
function reportWhy(marked: Marked[]): void {
  const arms: [string, string, string[]][] = [
    ["out of sample, on the one gap's weights", WARY, Object.keys(WHY)],
    ["in sample, on the shipped constant", SHIPPED, Object.keys(WHY).map(inSample)],
  ];
  const width = Math.max(...READERS.map((r) => r.length)) + 2;

  for (const [over, base, readers] of arms) {
    console.log(`\nthe whole pool by cut, ${over}: MAE, then the cuts it beats ${base} at`);
    console.log("".padEnd(width) + CUTS.map((c) => `wk ${c}`.padEnd(8)).join("") + "mean    beats");

    for (const reader of [base, ...readers]) {
      const at = marked.map((m) => mae(m.said[reader]!, m.was));
      const was = marked.map((m) => mae(m.said[base]!, m.was));
      const beats = at.filter((e, i) => e < was[i]! - 1e-9).length;

      console.log(
        reader.padEnd(width) + at.map((e) => e.toFixed(3).padEnd(8)).join("") +
          (at.reduce((s, e) => s + e, 0) / at.length).toFixed(3).padEnd(8) +
          (reader === base ? "" : `${beats} of ${at.length}`),
      );
    }

    const heads = {
      name: (r: string) =>
        r === "preseason anchor" ? "anchor" : r === base ? "wary" : tagOf(r),
      column: 15,
    };

    reportSplit(
      marked, [base, ...readers],
      `by the move in his snap share over his last three games, ${over}, every cut pooled`,
      MOVES.map(([label, keep]) => [label, (at, i) => keep(at.move[i]!)]),
      heads,
    );
    reportSplit(
      marked, ["preseason anchor", base, ...readers],
      `the men whose snaps rose .20 or more, by why, ${over}`,
      byReason(rose20, "rose .20 or more"),
      heads,
    );
    reportSplit(
      marked, ["preseason anchor", base, ...readers],
      `any game of his last three .20 over his share before, by why, ${over}`,
      byReason(roseAGame, "rose in a game"),
      heads,
    );

    console.log(
      `\nMAE less ${base}'s season by season, ${over}: the whole pool, then the rises of .20`,
    );
    console.log("".padEnd(width) + MARKED.map((y) => String(y).padEnd(15)).join(""));

    for (const reader of readers) {
      console.log(reader.padEnd(width) + MARKED.map((year) => {
        const inYear: Keep = (at, i) => at.season[i] === year;
        const all = pairedDifference(marked, reader, base, inYear, 0).diff;
        const rises = pairedDifference(
          marked, reader, base, (at, i) => inYear(at, i) && rose20(at, i), 0).diff;

        return `${all.toFixed(3)} ${rises.toFixed(3)}`.padEnd(15);
      }).join(""));
    }

    console.log(
      `\nMAE less ${base}'s, ${over}, and its standard error by a paired ` +
        `bootstrap of whole players (${DRAWS} draws)`,
    );
    console.log(
      "".padEnd(width) + "rose .20 or more       rose in a game         whole pool",
    );

    for (const reader of readers) {
      console.log(reader.padEnd(width) + [rose20, roseAGame, everyRow].map((keep) => {
        const d = pairedDifference(marked, reader, base, keep);

        return `${d.diff >= 0 ? "+" : ""}${d.diff.toFixed(4)} ± ${d.se.toFixed(4)}`.padEnd(23);
      }).join(""));
    }
  }

  const players = (keep: Keep) =>
    pairedDifference(marked, WARY, WARY, keep);
  console.log(
    `\nrows and players: rose .20 or more ${players(rose20).rows} rows, ` +
      `${players(rose20).players} players; rose in a game ${players(roseAGame).rows}, ` +
      `${players(roseAGame).players}; whole pool ${players(everyRow).rows}, ` +
      `${players(everyRow).players}`,
  );
}

/** wide enough for the longest reader's name */
const LABEL_WIDTH = Math.max(...READERS.map((r) => r.length)) + 2;

function report(marked: Marked): void {
  const surprised = marked.surprise.filter(Boolean).length;

  console.log(
    `\nafter week ${marked.cut}: ${marked.was.length} players, ` +
      `${surprised} of them with a changed role`,
  );
  console.log(
    "".padEnd(LABEL_WIDTH) + "MAE    corr    role changed: MAE    corr",
  );

  for (const reader of READERS) {
    const said = marked.said[reader]!;
    const keptSaid = said.filter((_, i) => marked.surprise[i]);
    const keptWas = marked.was.filter((_, i) => marked.surprise[i]);

    console.log(
      `${reader.padEnd(LABEL_WIDTH)}${mae(said, marked.was).toFixed(3)}  ` +
        `${correlation(said, marked.was).toFixed(3)}   ` +
        `${mae(keptSaid, keptWas).toFixed(3).padStart(15)}  ` +
        `${correlation(keptSaid, keptWas).toFixed(3)}`,
    );
  }
}

/**
 * How far this season has moved a player from where August had him, in
 * units of his own projection, read off his usage so the split is not
 * made by the same points the update is marked against.
 */
function surpriseOf(fit: InSeasonFit, row: Row): number {
  const said = updateLevel(fit, row);

  return Math.abs(said.roleLevel - row.anchor) / Math.max(4, row.anchor);
}

function describe(shape: UpdateShape): string {
  const gapOf = (gap: number) => Number.isFinite(gap) ? gap.toFixed(2) : "off";
  const drop = shape.dropGap === undefined
    ? ""
    : `, drops ${gapOf(shape.dropGap)}${shape.dropHeld ? " held" : ""}`;

  return (
    `role ${shape.roleCap} at half by ${shape.roleGames}, ` +
    `points ${shape.pointsCap} at half by ${shape.pointsGames}, ` +
    `decay ${shape.decay}, break ${gapOf(shape.breakGap)}${drop}`
  );
}

function cutAt(values: number[], share: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.floor(sorted.length * (1 - share));

  return sorted[Math.min(at, sorted.length - 1)] ?? Infinity;
}

async function main(): Promise<void> {
  const years = seasons(FIRST_DATA, LIVE);
  const data = await buildSeasonData(years);
  const games = await loadGames();
  const prior: Prior = {
    examples: new Map(),
    rookies: new Map(),
    unread: new Map(),
  };

  for (const year of seasons(FIRST_ANCHOR, LIVE)) {
    prior.examples.set(year, await examplesForTransition(year, data));
    prior.rookies.set(year, await rookiesFor(year, data, games));
    prior.unread.set(
      year,
      await rookiesFor(year, data, games, { alsoUnread: true }),
    );
  }

  const built = new Map<number, Season>();

  for (const year of seasons(FIRST_BOARD, LIVE)) {
    const anchors = anchorsFor(year, prior);
    const read = await readPlayedWeeks(year);

    for (const [playerId, anchor] of anchors) {
      anchor.name = read.byName.get(playerId) ?? anchor.name;
    }

    built.set(year, {
      anchors,
      weeks: read.weeks,
      roleRows: roleRowsFrom(read),
      ...(MARKED.includes(year) ? { rooms: await readRooms(year) } : {}),
    });
    console.log(`${year}: ${anchors.size} anchors, ${read.weeks.size} played`);
  }

  const marked = new Map<number, Marked>(
    CUTS.map((cut) => [
      cut,
      {
        cut,
        was: [],
        said: Object.fromEntries(READERS.map((r) => [r, []])),
        surprise: [],
        move: [],
        who: [],
        season: [],
        rise: [],
      },
    ]),
  );
  const fits = new Map<number, InSeasonFit>();

  for (const year of [...MARKED, LIVE]) {
    const roleRows: RoleLevelRow[] = [];
    const cases: UpdateCase[] = [];

    for (const earlier of seasons(
      FIRST_BOARD,
      Math.min(year - 1, LAST_PLAYED),
    )) {
      const season = built.get(earlier)!;
      roleRows.push(...season.roleRows);

      for (const cut of CUTS) {
        cases.push(...rowsAt(season, earlier, cut));
      }
    }

    const fit = fitInSeasonUpdate(roleRows, cases);
    fits.set(year, fit);
    console.log(`${year}: ${roleRows.length} player seasons, ` +
      `${cases.length} training cuts, ${describe(fit.shape)}`);

    /**
     * The same fit with one part switched off, so each part is marked
     * against the update without it rather than against nothing.
     */
    const without = new Map<string, InSeasonFit>();

    // fitted for the live season too, which prints the gap a drop would
    // ship at off every finished season
    for (const [label, drops] of Object.entries(DROPS)) {
      const shape = fitUpdateShape(fit.role, cases, {}, drops);

      without.set(label, { role: fit.role, shape });
      console.log(`  ${label}: ${describe(shape)}`);
    }

    // The live season is fitted for the table at the end and not marked.
    // Its few weeks after a cut made a rest of season of two or three
    // games, and since the parts switched off below were never fitted for
    // it, they were marked on fewer players than the update was.
    if (year === LIVE) {
      continue;
    }

    for (const [label, held] of Object.entries(ABLATIONS)) {
      const fixed = { decay: fit.shape.decay, breakGap: fit.shape.breakGap, ...held };
      without.set(label, {
        role: fit.role,
        shape: fitUpdateShape(fit.role, cases, fixed),
      });
    }

    const oneGap = fitUpdateShape(fit.role, cases, { breakGap: 0.2 });

    without.set(ONE_GAP, { role: fit.role, shape: oneGap });
    without.set(DROP_ONLY, {
      role: fit.role,
      shape: { ...oneGap, breakGap: Infinity, dropGap: oneGap.breakGap },
    });

    for (const [label, rise] of Object.entries(RISES)) {
      without.set(label, { role: fit.role, shape: { ...oneGap, ...rise } });
    }

    for (const [label, riseBy] of Object.entries(WHY)) {
      without.set(label, {
        role: fit.role,
        shape: { ...oneGap, ...RISES[WARY], riseBy },
      });
      without.set(inSample(label), {
        role: fit.role,
        shape: { ...SHIPPED_SHAPE, riseBy },
      });
    }

    const season = built.get(year)!;

    for (const cut of CUTS) {
      // why his snaps rose, off the rosters as they stood at the cut
      const rows = rowsAt(season, year, cut).map((row) => ({
        ...row, rise: readRise(season.rooms!, row.playerId, row.weeks, cut),
      }));
      const surprises = rows.map((row) => surpriseOf(fit, row));
      const line = cutAt(surprises, SURPRISE_SHARE);
      const into = marked.get(cut)!;

      rows.forEach((row, i) => {
        into.was.push(row.restPpg);
        into.said["preseason anchor"]!.push(row.anchor);
        into.said["season to date"]!.push(row.toDatePpg);
        into.said[UPDATE]!.push(updateLevel(fit, row).ppg);
        into.said[SHIPPED]!.push(
          updateLevel({ role: fit.role, shape: SHIPPED_SHAPE }, row).ppg,
        );
        into.said[SHIPPED_WARY]!.push(updateLevel(
          { role: fit.role, shape: { ...SHIPPED_SHAPE, ...WARY_RISE } }, row).ppg);
        into.said["oracle"]!.push(row.restPpg);

        for (const [label, ablated] of without) {
          into.said[label]!.push(updateLevel(ablated, row).ppg);
        }

        into.surprise.push(surprises[i]! >= line);
        into.move.push(snapMove(row.weeks));
        into.who.push(row.playerId);
        into.season.push(year);
        into.rise.push(row.rise);
      });
    }
  }

  for (const cut of CUTS) {
    report(marked.get(cut)!);
  }

  reportMoves([...marked.values()], [
    UPDATE, ONE_GAP, DROP_ONLY, ...Object.keys(RISES), ...Object.keys(DROPS), SHIPPED, SHIPPED_WARY,
  ], "every cut pooled");

  for (const cut of CUTS.filter((c) => c > MOVE_WINDOW)) {
    reportMoves(
      [marked.get(cut)!], [UPDATE, ONE_GAP, DROP_ONLY, ...Object.keys(RISES)], `after week ${cut} alone`);
  }

  reportWhy([...marked.values()]);

  await withSleeperNext(built, fits);

  showMovers(built, fits);

  for (const [year, who] of TRACED) {
    trace(built.get(year), fits.get(year), year, who);
  }

  showLive(built, fits.get(LIVE)!);
}

/** the weights Sleeper's next week is tried at beside the update */
const SLEEPER_WEIGHTS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6];

/**
 * Whether Sleeper's projection for the week after the cut says something
 * about the rest of the season the update does not. Sleeper hears about a
 * depth chart or a teammate's injury before the box score shows it, which
 * is the short term part of a role that usage reads only once it has
 * been played.
 *
 * Only the next week is read, since Sleeper revises a week right up to
 * its kickoff and a week further out would carry news the cut could not
 * have had. Only the players Sleeper has playing that week are marked, as
 * a projection of nothing is about his availability rather than his level.
 * Its seasons are 2024 and 2025, so the weight is picked on one and
 * scored on the other.
 */
async function withSleeperNext(
  built: Map<number, Season>, fits: Map<number, InSeasonFit>,
): Promise<void> {
  const projections = await loadSleeperWeekly();
  const years = [2024, 2025];
  const errors = new Map<number, number[][]>(years.map((y) => [y, []]));

  for (const year of years) {
    const fit = fits.get(year);
    const season = built.get(year);

    if (!fit || !season) {
      return;
    }

    for (const cut of CUTS) {
      for (const row of rowsAt(season, year, cut)) {
        const said = projections.get(projectionKey(year, cut + 1, row.playerId));

        if (!said) {
          continue;
        }

        const next = sleeperPointsUnder(said, scoring().receptions);

        if (next <= 0) {
          continue;
        }

        const update = updateLevel(fit, row).ppg;

        errors.get(year)!.push(SLEEPER_WEIGHTS.map((w) =>
          Math.abs((1 - w) * update + w * next - row.restPpg)));
      }
    }
  }

  const meanAt = (rows: number[][], i: number) =>
    rows.reduce((sum, r) => sum + r[i]!, 0) / Math.max(1, rows.length);

  console.log("\nthe update beside Sleeper's next week, MAE");
  console.log("weight  " + years.map((y) => `${y} (${errors.get(y)!.length})`)
    .join("  "));

  SLEEPER_WEIGHTS.forEach((w, i) => {
    console.log(`${w.toFixed(1).padEnd(8)}` + years
      .map((y) => meanAt(errors.get(y)!, i).toFixed(3).padEnd(12)).join(""));
  });

  for (const [fitOn, markOn] of [[2024, 2025], [2025, 2024]] as const) {
    const on = errors.get(fitOn)!;
    const best = SLEEPER_WEIGHTS
      .map((_, i) => i)
      .reduce((a, b) => meanAt(on, b) < meanAt(on, a) ? b : a);
    const marked = errors.get(markOn)!;

    console.log(
      `picked on ${fitOn}: ${SLEEPER_WEIGHTS[best]}, marked on ${markOn} ` +
        `${meanAt(marked, best).toFixed(3)} against ` +
        `${meanAt(marked, 0).toFixed(3)} for the update alone`);
  }
}

/** players worth following cut by cut, by season and by name */
const TRACED: [number, string][] = [
  [2025, "Travis Hunter"],
  [LIVE, "Travis Hunter"],
  [2023, "Puka Nacua"],
  [2020, "Michael Thomas"],
  [2025, "Rico Dowdle"],
];

/** one player's number at each cut, against what he went on to average */
function trace(
  season: Season | undefined,
  fit: InSeasonFit | undefined,
  year: number,
  who: string,
): void {
  const found = [...(season?.anchors ?? [])].find(
    ([, anchor]) => anchor.name === who,
  );

  if (!season || !fit || !found) {
    console.log(`\n${who} ${year}: no anchor on file`);

    return;
  }

  const [playerId, anchor] = found;
  const his = season.weeks.get(playerId) ?? [];
  console.log(
    `\n${who} ${year}, anchor ${anchor.ppg.toFixed(1)} at ${anchor.position}`,
  );
  console.log("cut  games  snaps  to date  role  update  rest of season");

  for (const cut of CUTS) {
    const before = his.filter((w) => w.week <= cut);
    const after = his.filter((w) => w.week > cut);

    if (before.length === 0) {
      continue;
    }

    const said = updateLevel(fit, {
      anchor: anchor.ppg,
      position: anchor.position,
      weeks: before,
    });
    const snaps = before.reduce((s, w) => s + w.snapShare, 0) / before.length;
    const rest = after.length === 0
      ? "none"
      : (after.reduce((s, w) => s + w.points, 0) / after.length).toFixed(1);

    console.log(
      `${String(cut).padStart(3)}${String(before.length).padStart(7)}` +
        `${snaps.toFixed(2).padStart(7)}${said.toDatePpg.toFixed(1).padStart(9)}` +
        `${said.roleLevel.toFixed(1).padStart(6)}${said.ppg.toFixed(1).padStart(8)}` +
        `${rest.padStart(16)}`,
    );
  }
}

/** the players this season moved furthest, and what each reader said */
function showMovers(
  built: Map<number, Season>,
  fits: Map<number, InSeasonFit>,
): void {
  const cut = 6;
  const shown: {
    name: string; season: number; anchor: number; toDate: number;
    role: number; update: number; was: number;
  }[] = [];

  for (const year of MARKED) {
    const fit = fits.get(year)!;

    for (const row of rowsAt(built.get(year)!, year, cut)) {
      const said = updateLevel(fit, row);
      shown.push({
        name: row.name,
        season: year,
        anchor: row.anchor,
        toDate: row.toDatePpg,
        role: said.roleLevel,
        update: said.ppg,
        was: row.restPpg,
      });
    }
  }

  shown.sort((a, b) => Math.abs(b.role - b.anchor) - Math.abs(a.role - a.anchor));
  console.log(`\nthe twelve biggest role moves after week ${cut}`);
  console.log(
    "player".padEnd(24) + "season  anchor  to date  role  update  actual",
  );

  for (const row of shown.slice(0, 12)) {
    console.log(
      row.name.padEnd(24) +
        `${row.season}  ${row.anchor.toFixed(1).padStart(6)}  ` +
        `${row.toDate.toFixed(1).padStart(7)}  ${row.role.toFixed(1).padStart(4)}  ` +
        `${row.update.toFixed(1).padStart(6)}  ${row.was.toFixed(1).padStart(6)}`,
    );
  }
}

/** what the update says about the season the board is actually on */
function showLive(built: Map<number, Season>, fit: InSeasonFit): void {
  const season = built.get(LIVE);

  if (!season) {
    return;
  }

  const shown: { name: string; games: number; anchor: number; said: number }[] = [];

  for (const [playerId, anchor] of season.anchors) {
    const weeks = season.weeks.get(playerId) ?? [];

    if (weeks.length === 0) {
      continue;
    }

    const said = updateLevel(fit, {
      anchor: anchor.ppg,
      position: anchor.position,
      weeks,
    });
    shown.push({
      name: anchor.name,
      games: weeks.length,
      anchor: anchor.ppg,
      said: said.ppg,
    });
  }

  shown.sort((a, b) => Math.abs(b.said - b.anchor) - Math.abs(a.said - a.anchor));
  console.log(`\n${LIVE} so far, the ten the update moves furthest`);
  console.log("player".padEnd(24) + "games  anchor  update");

  for (const row of shown.slice(0, 10)) {
    console.log(
      row.name.padEnd(24) +
        `${String(row.games).padStart(5)}  ${row.anchor.toFixed(1).padStart(6)}  ` +
        `${row.said.toFixed(1).padStart(6)}`,
    );
  }

  const hunter = shown.find((row) => row.name.includes("Hunter"));

  if (hunter) {
    console.log(
      `\n${hunter.name}: anchor ${hunter.anchor.toFixed(1)}, ` +
        `update ${hunter.said.toFixed(1)} off ${hunter.games} games`,
    );
  }
}

await main();
