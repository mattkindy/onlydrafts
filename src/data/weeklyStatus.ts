/**
 * What a lineup setter knows on Sunday morning that the box scores do
 * not say: who his club ruled out this week, who is questionable, and
 * where the club listed him on its depth chart.
 *
 * A man ruled Out or Doubtful is treated as not playing, the same call
 * the played world makes when it builds a week. Questionable men stay,
 * because most of them play.
 *
 * The depth chart release changed shape in 2025: dated snapshots with
 * no week column, so those seasons use the last chart published before
 * the opener for every week. Nothing before 2022 has a file, which is
 * why callers get a flag saying whether the season is covered.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "./csv.js";
import { loadDepthChart } from "./depthCharts.js";
import { RAW_DIR } from "./nflverse.js";

export interface WeekStatus {
  /** ruled Out or Doubtful, so he is not expected to play */
  out: boolean;
  questionable: boolean;
  /** limited in practice, or did not practice at all */
  limitedPractice: boolean;
  team: string;
  position: string;
}

const RULED_OUT = ["Out", "Doubtful"];

function statusKey(playerId: string, week: number): string {
  return `${playerId}|${week}`;
}

/** every listed man, week by week, keyed by player and week */
export async function loadWeeklyInjuryStatus(
  season: number,
): Promise<Map<string, WeekStatus>> {
  const text = await readFile(
    join(RAW_DIR, `injuries_${season}.csv`),
    "utf8",
  ).catch(() => "");
  const byWeek = new Map<string, WeekStatus>();

  if (!text) {
    return byWeek;
  }

  for (const row of parseCsv(text)) {
    const playerId = row["gsis_id"] ?? "";
    const week = Number(row["week"]);

    if (row["game_type"] !== "REG" || !playerId || !Number.isFinite(week)) {
      continue;
    }

    const report = row["report_status"] ?? "";
    const practice = (row["practice_status"] ?? "").toLowerCase();

    byWeek.set(statusKey(playerId, week), {
      out: RULED_OUT.includes(report),
      questionable: report === "Questionable",
      limitedPractice:
        practice.includes("limited") || practice.includes("did not"),
      team: row["team"] ?? "",
      position: row["position"] ?? "",
    });
  }

  return byWeek;
}

export interface WeeklyDepth {
  /** false when the season has no depth chart file to read */
  covered: boolean;
  /** where he was listed at his own position, one for the starter */
  rankFor(playerId: string, week: number): number | undefined;
}

const SKILL_POSITIONS = ["QB", "RB", "WR", "TE"];

function emptyDepth(): WeeklyDepth {
  return { covered: false, rankFor: () => undefined };
}

/**
 * A man can be listed at more than one spot, on returns as well as on
 * offence, so his highest standing wins.
 */
function keepBest(ranks: Map<string, number>, key: string, rank: number): void {
  const already = ranks.get(key);

  if (already !== undefined && already <= rank) {
    return;
  }

  ranks.set(key, rank);
}

export async function loadWeeklyDepthRanks(
  season: number,
): Promise<WeeklyDepth> {
  const text = await readFile(
    join(RAW_DIR, `depth_charts_${season}.csv`),
    "utf8",
  ).catch(() => "");

  if (!text) {
    return emptyDepth();
  }

  const rows = parseCsv(text);

  if (rows.length === 0) {
    return emptyDepth();
  }

  if (rows[0]!["pos_rank"] !== undefined) {
    const preseason = await loadDepthChart(season);
    return {
      covered: true,
      rankFor: (playerId) => preseason.get(playerId)?.rank,
    };
  }

  const ranks = new Map<string, number>();

  for (const row of rows) {
    const playerId = row["gsis_id"] ?? "";
    const position = row["position"] ?? "";
    const rank = Number(row["depth_team"]);
    const week = Number(row["week"]);

    if (row["game_type"] !== "REG" || !playerId.startsWith("00-")) {
      continue;
    }

    if (!SKILL_POSITIONS.includes(position) || row["depth_position"] !== position) {
      continue;
    }

    if (!Number.isFinite(rank) || !Number.isFinite(week)) {
      continue;
    }

    keepBest(ranks, statusKey(playerId, week), rank);
  }

  return {
    covered: true,
    rankFor: (playerId, week) => ranks.get(statusKey(playerId, week)),
  };
}

export interface WeeklyAvailability {
  status: Map<string, WeekStatus>;
  depth: WeeklyDepth;
}

export async function loadWeeklyAvailability(
  season: number,
): Promise<WeeklyAvailability> {
  const [status, depth] = await Promise.all([
    loadWeeklyInjuryStatus(season),
    loadWeeklyDepthRanks(season),
  ]);

  return { status, depth };
}
