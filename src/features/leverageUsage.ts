/**
 * What share of his side's work a player took while the game was still in
 * the balance.
 *
 * Raw share cannot tell a back with eight first quarter carries in a tie
 * game from one with twelve down twenty one. Every play in the curated
 * leverage file is counted twice, once as itself and once weighted by how
 * much doubt was left about who wins, so a backup being worked into a
 * role that matters separates from one who only plays when the game is
 * gone.
 */

import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { splitLine } from "../data/csv.js";
import {
  LEVERAGE_SHAPE, SHIPPED_SHAPE, type LeverageShape,
} from "../model/leverage.js";

const CURATED = join(import.meta.dirname, "..", "..", "data", "curated");

/** the counts the file keeps, each once as itself and once weighted */
export const COUNTED = [
  "targets", "receptions", "airYards", "carries",
  "earlyTargets", "earlyCarries", "redLooks", "tenLooks",
] as const;

export type Counted = Record<(typeof COUNTED)[number], number>;

export interface LeverageRow {
  season: number;
  week: number;
  team: string;
  player: string;
  /** what he took, every play counting once */
  raw: Counted;
  /** the same work with each play weighted by leverage */
  weighted: Counted;
  /** his side's totals over the same plays, raw and weighted */
  side: Counted;
  sideWeighted: Counted;
}

export const zeroCounted = (): Counted =>
  Object.fromEntries(COUNTED.map((field) => [field, 0])) as Counted;

/** the header, and the order the writer and the reader both work in */
export const LEVERAGE_HEADER = [
  "season", "week", "team", "player",
  ...COUNTED,
  ...COUNTED.map((field) => `weighted_${field}`),
  ...COUNTED.map((field) => `team_${field}`),
  ...COUNTED.map((field) => `teamWeighted_${field}`),
].join(",");

/**
 * A shape other than the shipped one writes beside the shipped file
 * rather than over it, so the two can be measured against each other
 * without rebuilding a gigabyte of play files twice.
 */
export function leverageFile(shape: LeverageShape = LEVERAGE_SHAPE): string {
  const name = shape === SHIPPED_SHAPE ? "leverage.csv" : `leverage-${shape}.csv`;

  return join(CURATED, name);
}

/**
 * Every row for the seasons asked for, grouped by season.
 *
 * The file runs to tens of megabytes, so it is read a line at a time and
 * only the wanted seasons are kept.
 */
export async function loadLeverage(
  seasons: number[],
  shape: LeverageShape = LEVERAGE_SHAPE,
  warn: (said: string) => void = console.warn,
): Promise<Map<number, LeverageRow[]>> {
  const bySeason = new Map<number, LeverageRow[]>();
  const path = leverageFile(shape);

  if (!existsSync(path)) {
    warn("no leverage file, so nobody has any counted work. " +
      "Run scripts/aggregateLeverage.ts");

    return bySeason;
  }

  const wanted = new Set(seasons);
  const reader = createInterface({ input: createReadStream(path) });
  let header = true;

  for await (const line of reader) {
    if (header) {
      header = false;
      continue;
    }

    if (line === "") {
      continue;
    }

    const cells = splitLine(line);
    const season = Number(cells[0]);

    if (!wanted.has(season)) {
      continue;
    }

    const rows = bySeason.get(season) ?? [];
    rows.push(rowFrom(season, cells));
    bySeason.set(season, rows);
  }

  return bySeason;
}

function rowFrom(season: number, cells: string[]): LeverageRow {
  const block = (offset: number): Counted =>
    Object.fromEntries(COUNTED.map((field, i) =>
      [field, Number(cells[offset + i]) || 0])) as Counted;

  return {
    season,
    week: Number(cells[1]),
    team: cells[2] ?? "",
    player: cells[3] ?? "",
    raw: block(4),
    weighted: block(4 + COUNTED.length),
    side: block(4 + COUNTED.length * 2),
    sideWeighted: block(4 + COUNTED.length * 3),
  };
}

/** how many weeks back the trend looks */
const WINDOW = 3;

/**
 * How many weighted chances a trend needs before it counts as its own. A
 * side throws it about thirty five times a week, so three full weeks
 * counts about two thirds of itself and a back who has played twice
 * counts far less.
 */
const SETTLES = Number(process.env["TREND_SETTLES"] ?? 40);

const share = (part: number, whole: number) => (whole > 0 ? part / whole : 0);

export interface Usage {
  player: string;
  position: string;
  team: string;
  /** how many weeks of his own the count rests on */
  weeks: number;
  /** the targets and carries he took, so a caller can drop the thin ones */
  work: number;
  /** his share of his side's targets, weighted by leverage and as it was */
  targetShare: number;
  rawTargetShare: number;
  carryShare: number;
  rawCarryShare: number;
  /** and of the two together, which is the one number for a back */
  workShare: number;
  rawWorkShare: number;
  /**
   * The last three weeks against everything before them, pulled toward
   * what his position did over the same stretch.
   */
  targetTrend: number;
  carryTrend: number;
}

export interface Through {
  season: number;
  /** the last week that may be read, and nothing after it */
  through: number;
  positions: Map<string, string>;
}

type Pair = Record<"targets" | "carries", number>;

/** what one player took, by week, and which club he took it for */
interface Own {
  byWeek: Map<number, { raw: Counted; weighted: Counted }>;
  forTeam: Map<string, number>;
}

/** a change in share and how much of it is the player's own */
interface Change {
  change: number;
  credit: number;
}

function add(into: Counted, from: Counted): void {
  for (const field of COUNTED) {
    into[field] += from[field];
  }
}

/**
 * A side's totals for one week are repeated on every row that week, so
 * they are read once here. Dividing a player by his club's whole stretch
 * rather than by the weeks he played means a missed game counts against
 * him, which is how the rest of the model reads a share.
 */
function sidesIn(
  rows: LeverageRow[], at: Through,
): Map<string, { raw: Counted; weighted: Counted }> {
  const byWeek = new Map<string, { raw: Counted; weighted: Counted }>();

  for (const row of rows) {
    if (row.season !== at.season || row.week > at.through) {
      continue;
    }

    const key = `${row.team}|${row.week}`;

    if (!byWeek.has(key)) {
      byWeek.set(key, { raw: row.side, weighted: row.sideWeighted });
    }
  }

  return byWeek;
}

function ownIn(rows: LeverageRow[], at: Through): Map<string, Own> {
  const byPlayer = new Map<string, Own>();

  for (const row of rows) {
    if (row.season !== at.season || row.week > at.through || !row.player) {
      continue;
    }

    const own = byPlayer.get(row.player)
      ?? { byWeek: new Map(), forTeam: new Map() };
    const week = own.byWeek.get(row.week)
      ?? { raw: zeroCounted(), weighted: zeroCounted() };
    add(week.raw, row.raw);
    add(week.weighted, row.weighted);
    own.byWeek.set(row.week, week);
    own.forTeam.set(
      row.team,
      (own.forTeam.get(row.team) ?? 0) + row.raw.targets + row.raw.carries,
    );
    byPlayer.set(row.player, own);
  }

  return byPlayer;
}

/** the club he did most of his work for, which is nearly always his only one */
function clubOf(own: Own): string {
  let team = "";
  let most = -1;

  for (const [candidate, work] of own.forTeam) {
    if (work > most) {
      team = candidate;
      most = work;
    }
  }

  return team;
}

interface Totals {
  own: Counted;
  side: Counted;
  rawOwn: Counted;
  rawSide: Counted;
}

function totalsFor(
  own: Own,
  team: string,
  sides: Map<string, { raw: Counted; weighted: Counted }>,
  from: number,
  to: number,
): Totals {
  const totals: Totals = {
    own: zeroCounted(), side: zeroCounted(),
    rawOwn: zeroCounted(), rawSide: zeroCounted(),
  };

  for (let week = from; week <= to; week++) {
    const side = sides.get(`${team}|${week}`);

    if (!side) {
      continue;
    }

    add(totals.side, side.weighted);
    add(totals.rawSide, side.raw);
    const his = own.byWeek.get(week);

    if (his) {
      add(totals.own, his.weighted);
      add(totals.rawOwn, his.raw);
    }
  }

  return totals;
}

/**
 * The change in his share over the window, and how much of it counts as
 * his own. A club with no weeks on one side of the window gives its
 * players no change to report, which is every player before week four, so
 * they take their position's mean rather than a number off nothing.
 */
function changeIn(
  recent: Totals, earlier: Totals, field: keyof Counted,
): Change {
  const behindIt = Math.min(recent.side[field], earlier.side[field]);

  if (behindIt <= 0) {
    return { change: 0, credit: 0 };
  }

  return {
    change: share(recent.own[field], recent.side[field])
      - share(earlier.own[field], earlier.side[field]),
    credit: behindIt / (behindIt + SETTLES),
  };
}

const pulled = (seen: Change, mean: number) =>
  seen.credit * seen.change + (1 - seen.credit) * mean;

/**
 * What each position's trend averaged over the same stretch, weighted by
 * the chances behind each player's. It comes out near zero, which is the
 * point: a back with two weeks behind him is pulled back to no trend at
 * all where one with six keeps most of his own.
 */
function meansBy(
  seen: Map<string, Record<"targets" | "carries", Change>>,
  positions: Map<string, string>,
): Map<string, Pair> {
  const sums = new Map<string, { change: Pair; credit: Pair }>();

  for (const [player, change] of seen) {
    const position = positions.get(player) ?? "";
    const at = sums.get(position) ?? {
      change: { targets: 0, carries: 0 },
      credit: { targets: 0, carries: 0 },
    };

    for (const field of ["targets", "carries"] as const) {
      at.change[field] += change[field].change * change[field].credit;
      at.credit[field] += change[field].credit;
    }

    sums.set(position, at);
  }

  const out = new Map<string, Pair>();

  for (const [position, at] of sums) {
    out.set(position, {
      targets: share(at.change.targets, at.credit.targets),
      carries: share(at.change.carries, at.credit.carries),
    });
  }

  return out;
}

/**
 * Every player's leverage weighted share through a week, with the raw
 * share beside it and a shrunk trend.
 *
 * Later weeks are dropped here rather than by the caller, so a bench
 * cannot read a week it should not know about by forgetting to cut them.
 */
export function leverageUsage(
  rows: LeverageRow[],
  at: Through,
): Map<string, Usage> {
  const sides = sidesIn(rows, at);
  const owns = ownIn(rows, at);
  const through = new Map<string, Totals>();
  const changes = new Map<string, Record<"targets" | "carries", Change>>();
  const teams = new Map<string, string>();
  const from = at.through - WINDOW + 1;

  for (const [player, own] of owns) {
    const team = clubOf(own);
    teams.set(player, team);
    through.set(player, totalsFor(own, team, sides, 1, at.through));
    const recent = totalsFor(own, team, sides, from, at.through);
    const earlier = totalsFor(own, team, sides, 1, from - 1);
    changes.set(player, {
      targets: changeIn(recent, earlier, "targets"),
      carries: changeIn(recent, earlier, "carries"),
    });
  }

  const means = meansBy(changes, at.positions);
  const out = new Map<string, Usage>();

  for (const [player, own] of owns) {
    const totals = through.get(player)!;
    const position = at.positions.get(player) ?? "";
    const mean = means.get(position) ?? { targets: 0, carries: 0 };
    const change = changes.get(player)!;

    out.set(player, {
      player,
      position,
      team: teams.get(player)!,
      weeks: own.byWeek.size,
      work: totals.rawOwn.targets + totals.rawOwn.carries,
      targetShare: share(totals.own.targets, totals.side.targets),
      rawTargetShare: share(totals.rawOwn.targets, totals.rawSide.targets),
      carryShare: share(totals.own.carries, totals.side.carries),
      rawCarryShare: share(totals.rawOwn.carries, totals.rawSide.carries),
      workShare: share(
        totals.own.targets + totals.own.carries,
        totals.side.targets + totals.side.carries,
      ),
      rawWorkShare: share(
        totals.rawOwn.targets + totals.rawOwn.carries,
        totals.rawSide.targets + totals.rawSide.carries,
      ),
      targetTrend: pulled(change.targets, mean.targets),
      carryTrend: pulled(change.carries, mean.carries),
    });
  }

  return out;
}
