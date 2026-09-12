/**
 * One week's projections, read into what the start/sit view works with.
 *
 * The build writes a file per week and lists them in the index. Reading
 * them is the only place that knows those file names and field names.
 *
 * Two numbers arrive for every man: ours, from the weekly model, and
 * Sleeper's. They mostly agree. Where they do not, the gap is worth
 * showing, because the pair bench says the wider gaps are the ones that
 * decide a matchup.
 */

import { normalizeName } from "./store.ts";

export interface WeekRef {
  season: number;
  week: number;
  file: string;
}

export interface SlateRow {
  playerId: string;
  name: string;
  position: string;
  team: string;
  opponent: string;
  home: boolean;
  ours: number;
  sleeper: number | null;
  blend: number;
  floor: number;
  ceiling: number;
  /**
   * His quartiles, where the build shipped them. An older slate has only
   * the floor, the middle and the ceiling, and then whoever draws his
   * week has to put the quartiles somewhere itself.
   */
  q1?: number;
  q3?: number;
  /** the receptions behind his points, so another scoring can move them */
  catches: number;
  questionable: boolean;
  gamesMissedRecent: number;
  absenceShare: number;
}

export interface Slate {
  season: number;
  week: number;
  generated: string;
  /** nobody has played a game yet, so these come from last season's rates */
  preseason: boolean;
  /** what a catch paid when the rows were scored */
  perCatch: number;
  rows: SlateRow[];
}

/** what the scheduled build scores, for a slate written before it said */
const BUILT_PER_CATCH = 0.5;

/** the file changes far more often than a browser expects */
const fresh = () => "?v=" + Math.floor(Date.now() / 60000);

/**
 * What the index lists. An older index kept bare week numbers, so one
 * of those is turned into the file it would have been written to rather
 * than dropping the week off the picker.
 */
export function weekRefs(
  listed: unknown, boardSeason: number,
): WeekRef[] {
  if (!Array.isArray(listed)) {
    return [];
  }

  const refs = listed.flatMap((entry): WeekRef[] => {
    if (typeof entry === "number") {
      return [{
        season: boardSeason,
        week: entry,
        file: `data/slate-${boardSeason}-${entry}.json`,
      }];
    }

    if (entry && typeof entry === "object" && "week" in entry) {
      const row = entry as Partial<WeekRef>;
      const season = row.season ?? boardSeason;
      const week = Number(row.week);

      return [{
        season,
        week,
        file: row.file ?? `data/slate-${season}-${week}.json`,
      }];
    }

    return [];
  });

  return refs.sort((a, b) => a.season - b.season || a.week - b.week);
}

/**
 * A row as the file has it. The build calls the middle number `average`
 * and its list `players`, the view asks for `blend` and `rows`, and
 * both spellings are taken so a week built either way still draws.
 */
interface FileRow {
  playerId?: string;
  key?: string;
  name: string;
  position: string;
  team: string;
  opponent: string;
  home?: boolean;
  ours: number;
  sleeper?: number | null;
  blend?: number;
  average?: number;
  floor: number;
  ceiling: number;
  q1?: number;
  q3?: number;
  catches?: number;
  questionable?: boolean;
  gamesMissedRecent?: number;
  gamesMissed?: number;
  absenceShare?: number;
}

interface FileSlate {
  season: number;
  week: number;
  generated?: string;
  preseason?: boolean;
  perCatch?: number;
  rows?: FileRow[];
  players?: FileRow[];
}

function readRow(row: FileRow): SlateRow {
  // the fixture arrives as "v NO" or "@ BAL" when no `home` comes with it
  const away = row.opponent.startsWith("@");

  return {
    playerId: row.playerId ?? row.key ?? normalizeName(row.name),
    name: row.name,
    position: row.position,
    team: row.team,
    opponent: row.opponent.replace(/^[v@]\s*/, ""),
    home: row.home ?? !away,
    ours: row.ours,
    sleeper: row.sleeper ?? null,
    blend: row.blend ?? row.average ?? row.ours,
    floor: row.floor,
    ceiling: row.ceiling,
    q1: row.q1,
    q3: row.q3,
    catches: row.catches ?? 0,
    questionable: Boolean(row.questionable),
    gamesMissedRecent: row.gamesMissedRecent ?? row.gamesMissed ?? 0,
    absenceShare: row.absenceShare ?? 0,
  };
}

export function readSlate(said: FileSlate): Slate {
  return {
    season: said.season,
    week: said.week,
    generated: said.generated ?? "",
    preseason: said.preseason ?? false,
    perCatch: said.perCatch ?? BUILT_PER_CATCH,
    rows: (said.rows ?? said.players ?? []).map(readRow),
  };
}

/**
 * The slate in a league's scoring. The rows were scored once, at the
 * build, and the three usual formats differ only in what a catch pays,
 * so every point figure moves by the difference times his catches. A
 * league paying what the build paid gets the rows back untouched.
 */
export function slateUnder(slate: Slate, perCatch: number): Slate {
  const shift = perCatch - slate.perCatch;

  if (shift === 0) {
    return slate;
  }

  const moved = (row: SlateRow, points: number | null | undefined) =>
    points === null || points === undefined
      ? points
      : Number((points + shift * row.catches).toFixed(1));

  return {
    ...slate,
    perCatch,
    rows: slate.rows.map((row) => ({
      ...row,
      ours: moved(row, row.ours)!,
      sleeper: moved(row, row.sleeper) ?? null,
      blend: moved(row, row.blend)!,
      floor: moved(row, row.floor)!,
      ceiling: moved(row, row.ceiling)!,
      q1: moved(row, row.q1) ?? undefined,
      q3: moved(row, row.q3) ?? undefined,
    })),
  };
}

export async function loadSlate(file: string): Promise<Slate> {
  const said = await fetch(file + fresh()).then((r) => r.json()) as FileSlate;

  return readSlate(said);
}

/**
 * How far apart the two projections are before the gap is worth
 * pointing at. Under three points either number sets the same lineup.
 */
export const SPLIT_AT = 3;

/** how often Sleeper has the better of it when they are that far apart */
export const SLEEPER_WINS_SPLITS = 55;

export const splitBy = (row: SlateRow) =>
  row.sleeper === null ? 0 : row.ours - row.sleeper;

export const isSplit = (row: SlateRow) =>
  Math.abs(splitBy(row)) >= SPLIT_AT;

/** said in full on hover, since the row itself has space for a chip */
export function splitNote(row: SlateRow): string {
  const by = splitBy(row);
  const side = by > 0
    ? `we have him ${by.toFixed(1)} points above Sleeper`
    : `Sleeper has him ${(-by).toFixed(1)} points above us`;

  return `${side}. When the two split by ${SPLIT_AT} points or more, ` +
    `Sleeper is right about ${SLEEPER_WINS_SPLITS}% of the time.`;
}

/** a fifth of a side's usual work missing is where the bench saw a jump */
export const STARTER_OUT_AT = 0.2;

export interface Verdict {
  gap: number;
  /** the man to start, or null when it is a coin flip */
  start: SlateRow | null;
  says: string;
}

/**
 * Which of two men to start, and how often that answer has been right.
 *
 * The three bands come from the pair bench: under two points every
 * method landed on about 54%, two to five on 66%, and five or more on
 * 83%. A gap of half a point is not a recommendation, so it is not
 * dressed up as one.
 */
export function verdict(a: SlateRow, b: SlateRow): Verdict {
  const gap = Math.abs(a.blend - b.blend);
  const ahead = a.blend >= b.blend ? a : b;

  if (gap < 2) {
    return {
      gap,
      start: null,
      says: "coin flip, either one. Under two points apart, whichever " +
        "you start wins about 54% of the time.",
    };
  }

  if (gap < 5) {
    return {
      gap,
      start: ahead,
      says: `lean ${ahead.name}. Two to five points apart, the higher ` +
        "projection wins about 66% of the time.",
    };
  }

  return {
    gap,
    start: ahead,
    says: `start ${ahead.name}. Five points or more apart, the higher ` +
      "projection wins about 83% of the time.",
  };
}

/** the men on your team, under the same normalized name the board uses */
export const rosterKeys = (men: { name: string }[]) =>
  new Set(men.map((m) => normalizeName(m.name)));

export const onRoster = (roster: Set<string> | null, row: SlateRow) =>
  Boolean(roster && roster.has(normalizeName(row.name)));
