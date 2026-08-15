import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "./csv.js";
import { RAW_DIR } from "./nflverse.js";

export interface TeamTendency {
  passRate: number;
  neutralPassRate: number;
}

let cached: Map<string, TeamTendency> | undefined;

/** `${team}|${season}` -> pass tendencies aggregated from play-by-play */
export async function loadTendencies(): Promise<Map<string, TeamTendency>> {
  if (cached) {
    return cached;
  }

  const rows = parseCsv(
    await readFile(join(RAW_DIR, "..", "curated", "teamTendencies.csv"), "utf8"),
  );
  cached = new Map(
    rows.map((row) => [
      `${row["team"]}|${row["season"]}`,
      {
        passRate: Number(row["passRate"]),
        neutralPassRate: Number(row["neutralPassRate"] || row["passRate"]),
      },
    ]),
  );

  return cached;
}

export interface WeekTendencyCounts {
  neutralPlays: number;
  neutralPasses: number;
}

let cachedWeeks: Map<string, WeekTendencyCounts> | undefined;

/** `${team}|${season}|${week}` -> neutral-situation play counts */
export async function loadWeeklyTendencyCounts(): Promise<
  Map<string, WeekTendencyCounts>
> {
  if (cachedWeeks) {
    return cachedWeeks;
  }

  const rows = parseCsv(
    await readFile(
      join(RAW_DIR, "..", "curated", "teamTendencyWeeks.csv"),
      "utf8",
    ),
  );
  cachedWeeks = new Map(
    rows.map((row) => [
      `${row["team"]}|${row["season"]}|${row["week"]}`,
      {
        neutralPlays: Number(row["neutralPlays"]),
        neutralPasses: Number(row["neutralPasses"]),
      },
    ]),
  );

  return cachedWeeks;
}
