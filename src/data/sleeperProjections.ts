/**
 * Sleeper's own weekly projections, keyed the way the rest of the repo
 * keys players.
 *
 * Sleeper publishes a projection per player-week under its own player
 * ids, so every row has to be joined to a gsis id before anything here
 * can use it. A player Sleeper has no gsis id for is dropped: he cannot
 * be matched to a weekly example, and guessing by name would quietly
 * pair up the wrong players. A player who matches but has no points goes to
 * the quiet file instead, so a reader can tell the two cases apart.
 *
 * The points column is full PPR, and catches let another scoring take
 * the point a catch back off. A defence comes in parts, in its own file.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "./csv.js";
import { canonicalTeam, RAW_DIR } from "./nflverse.js";
import { DEFENCE_PARTS, type Parts } from "../features/defenceWeek.js";

export const SLEEPER_WEEKLY_PATH = join(
  RAW_DIR,
  "..",
  "curated",
  "sleeperWeekly.csv",
);

/**
 * The players Sleeper listed for a week and gave no points to. They are the
 * backups and the players who are out, and the slate reads a player here as
 * Sleeper expecting nothing of him.
 */
export const SLEEPER_QUIET_PATH = join(
  RAW_DIR,
  "..",
  "curated",
  "sleeperQuiet.csv",
);

/**
 * A defence goes in its own file. Sleeper projects one in parts, a rate
 * per event and the points it gives up, and none of those columns mean
 * anything for a skill player.
 */
export const SLEEPER_DEFENCE_PATH = join(
  RAW_DIR,
  "..",
  "curated",
  "sleeperDefenceWeekly.csv",
);

export interface SleeperProjection {
  season: number;
  week: number;
  gsisId: string;
  position: string;
  points: number;
  targets: number;
  carries: number;
  /** undefined on a row fetched before catches were kept */
  catches?: number;
}

/** one row of the projections endpoint, cut down to what is used */
export interface SleeperProjectionRow {
  player_id: string;
  player?: { position?: string | null } | null;
  stats?: {
    pts_ppr?: number | null;
    rec?: number | null;
    rec_tgt?: number | null;
    rush_att?: number | null;
    /** a defence is projected in parts, one column an event */
    [stat: string]: number | null | undefined;
  } | null;
}

/**
 * His Sleeper points under a league's scoring. Sleeper's three formats
 * differ only in what a catch pays, so the full PPR number less the
 * difference per catch is exactly what Sleeper would publish for the
 * league. A row without catches stays as published.
 */
export function sleeperPointsUnder(
  projection: SleeperProjection, perCatch: number,
): number {
  if (projection.catches === undefined) {
    return projection.points;
  }

  return projection.points + (perCatch - 1) * projection.catches;
}

/** a player Sleeper lists for the week but publishes no points for */
export interface SleeperQuiet {
  season: number;
  week: number;
  gsisId: string;
}

interface JoinedProjections {
  projected: SleeperProjection[];
  /**
   * Sleeper returns its whole pool and gives points to the couple
   * of hundred it expects to play, so the rest are backups and players who
   * are out. Keeping them apart from the players nobody could match to
   * a gsis id is what lets the slate say Sleeper expects nothing of a
   * player rather than saying Sleeper has never heard of him.
   */
  quiet: SleeperQuiet[];
}

export function joinProjectionsToGsis(
  season: number,
  week: number,
  rows: SleeperProjectionRow[],
  gsisBySleeperId: Map<string, string>,
): JoinedProjections {
  const projected: SleeperProjection[] = [];
  const quiet: SleeperQuiet[] = [];

  for (const row of rows) {
    const gsisId = gsisBySleeperId.get(row.player_id);

    if (!gsisId) {
      continue;
    }

    const points = row.stats?.pts_ppr;

    if (points === undefined || points === null) {
      quiet.push({ season, week, gsisId });
      continue;
    }

    projected.push({
      season,
      week,
      gsisId,
      position: row.player?.position ?? "",
      points,
      targets: row.stats?.rec_tgt ?? 0,
      carries: row.stats?.rush_att ?? 0,
      catches: row.stats?.rec ?? 0,
    });
  }

  return { projected, quiet };
}

export function quietToCsv(rows: SleeperQuiet[]): string {
  const lines = [...rows]
    .sort((a, b) =>
      a.season - b.season || a.week - b.week || a.gsisId.localeCompare(b.gsisId))
    .map((r) => `${r.season},${r.week},${r.gsisId}`);

  return ["season,week,gsisId", ...lines].join("\n") + "\n";
}

export function parseQuiet(text: string): Set<string> {
  return new Set(
    parseCsv(text)
      .filter((row) => row["gsisId"])
      .map((row) =>
        projectionKey(
          Number(row["season"]), Number(row["week"]), row["gsisId"] ?? "",
        )),
  );
}

let cachedQuiet: Set<string> | undefined;

/**
 * Every player-week Sleeper listed without a number, under the same key
 * the projections use. The file may not be there on a checkout taken
 * before the fetch started writing it, and then nobody is quiet.
 */
export async function loadSleeperQuiet(): Promise<Set<string>> {
  if (cachedQuiet) {
    return cachedQuiet;
  }

  cachedQuiet = parseQuiet(
    await readFile(SLEEPER_QUIET_PATH, "utf8").catch(() => ""),
  );

  return cachedQuiet;
}

export function projectionKey(
  season: number,
  week: number,
  gsisId: string,
): string {
  return `${season}|${week}|${gsisId}`;
}

export interface SleeperDefence {
  season: number;
  week: number;
  /** the team abbreviation, which is the id Sleeper gives a defence */
  team: string;
  /** Sleeper's own standard number, which pays a return touchdown */
  points: number;
  pointsAllowed: number;
  parts: Parts;
}

const DEFENCE_COLUMNS = [
  "season", "week", "team", "points", "pts_allow", ...DEFENCE_PARTS,
];

export function joinDefenceProjections(
  season: number,
  week: number,
  rows: SleeperProjectionRow[],
): SleeperDefence[] {
  return rows.flatMap((row): SleeperDefence[] => {
    const stats = row.stats;

    if (!row.player_id || !stats) {
      return [];
    }

    return [{
      season,
      week,
      team: canonicalTeam(row.player_id),
      points: stats["pts_std"] ?? 0,
      pointsAllowed: stats["pts_allow"] ?? 0,
      parts: Object.fromEntries(
        DEFENCE_PARTS.map((part) => [part, stats[part] ?? 0]),
      ),
    }];
  });
}

export function defenceProjectionsToCsv(rows: SleeperDefence[]): string {
  const lines = [...rows]
    .sort((a, b) =>
      a.season - b.season || a.week - b.week || a.team.localeCompare(b.team))
    .map((r) => [
      r.season, r.week, r.team, r.points, r.pointsAllowed,
      ...DEFENCE_PARTS.map((part) => r.parts[part] ?? 0),
    ].join(","));

  return [DEFENCE_COLUMNS.join(","), ...lines].join("\n") + "\n";
}

let cachedDefences: Map<string, SleeperDefence> | undefined;

/** every defence week on disk, keyed season, week and team */
export async function loadSleeperDefences(): Promise<
  Map<string, SleeperDefence>
> {
  if (cachedDefences) {
    return cachedDefences;
  }

  const text = await readFile(SLEEPER_DEFENCE_PATH, "utf8").catch(() => "");
  const num = (row: Record<string, string>, key: string) =>
    Number(row[key] ?? 0) || 0;

  cachedDefences = new Map(
    parseCsv(text).map((row) => {
      const said: SleeperDefence = {
        season: num(row, "season"),
        week: num(row, "week"),
        team: row["team"] ?? "",
        points: num(row, "points"),
        pointsAllowed: num(row, "pts_allow"),
        parts: Object.fromEntries(
          DEFENCE_PARTS.map((part) => [part, num(row, part)]),
        ),
      };

      return [projectionKey(said.season, said.week, said.team), said];
    }),
  );

  return cachedDefences;
}

let cached: Map<string, SleeperProjection> | undefined;

export async function loadSleeperWeekly(): Promise<
  Map<string, SleeperProjection>
> {
  if (cached) {
    return cached;
  }

  const rows = parseCsv(await readFile(SLEEPER_WEEKLY_PATH, "utf8"));
  cached = new Map(
    rows.map((row) => {
      const projection: SleeperProjection = {
        season: Number(row["season"]),
        week: Number(row["week"]),
        gsisId: row["gsisId"] ?? "",
        position: row["position"] ?? "",
        points: Number(row["points"]),
        targets: Number(row["targets"]),
        carries: Number(row["carries"]),
      };

      if (row["catches"] !== undefined && row["catches"] !== "") {
        projection.catches = Number(row["catches"]);
      }

      return [
        projectionKey(projection.season, projection.week, projection.gsisId),
        projection,
      ];
    }),
  );

  return cached;
}
