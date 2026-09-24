import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "./csv.js";
import { RAW_DIR } from "./nflverse.js";

/** a season's injury report, or no rows when it has not been downloaded */
async function loadInjuryRows(
  season: number,
): Promise<Record<string, string>[]> {
  const text = await readFile(
    join(RAW_DIR, `injuries_${season}.csv`),
    "utf8",
  ).catch(() => "");

  return text ? parseCsv(text) : [];
}

/**
 * How many players the clubs listed as questionable for a week at the
 * given positions. A row with the status left blank is a club filing its
 * practice report before it has ruled anybody in or out.
 */
export function countQuestionable(
  rows: Record<string, string>[], week: number, positions: string[],
): number {
  return rows.filter((row) =>
    Number(row["week"]) === week &&
    (row["report_status"] ?? "").trim() === "Questionable" &&
    positions.includes((row["position"] ?? "").trim())).length;
}

export async function loadQuestionableCount(
  season: number, week: number, positions: string[],
): Promise<number> {
  return countQuestionable(await loadInjuryRows(season), week, positions);
}

/**
 * Weeks a player appeared on the injury report with his practice or
 * game status limited. A player who suits up while listed is playing
 * hurt, which is the case the season model cannot otherwise see.
 */
export async function loadCompromisedWeeks(
  season: number,
): Promise<Set<string>> {
  const compromised = new Set<string>();

  for (const row of await loadInjuryRows(season)) {
    if (row["game_type"] !== "REG" || !row["gsis_id"]) {
      continue;
    }

    const practice = (row["practice_status"] ?? "").toLowerCase();
    const report = (row["report_status"] ?? "").toLowerCase();
    const limited =
      practice.includes("limited") ||
      practice.includes("did not") ||
      report.includes("questionable") ||
      report.includes("doubtful") ||
      report.includes("out");

    if (limited) {
      compromised.add(`${row["gsis_id"]}|${row["week"]}`);
    }
  }

  return compromised;
}

interface InjuryWeek {
  week: number;
  /** the report's own words, lowercased */
  kind: string;
  softTissue: boolean;
}

const SOFT_TISSUE = [
  "hamstring",
  "groin",
  "quad",
  "calf",
  "hip flexor",
  "adductor",
  "achilles",
];

/**
 * Every listed week for a player, with the injury named. Soft tissue
 * trouble tends to shadow a player after he comes off the report,
 * which the plain listed and not listed split cannot express.
 */
export async function loadInjuryDetail(
  season: number,
): Promise<Map<string, InjuryWeek[]>> {
  const byPlayer = new Map<string, InjuryWeek[]>();

  for (const row of await loadInjuryRows(season)) {
    if (row["game_type"] !== "REG" || !row["gsis_id"]) {
      continue;
    }

    const practice = (row["practice_status"] ?? "").toLowerCase();
    const report = (row["report_status"] ?? "").toLowerCase();
    const limited =
      practice.includes("limited") ||
      practice.includes("did not") ||
      report.includes("questionable") ||
      report.includes("doubtful") ||
      report.includes("out");

    if (!limited) {
      continue;
    }

    const kind = (
      row["report_primary_injury"] ||
      row["practice_primary_injury"] ||
      ""
    ).toLowerCase();
    const list = byPlayer.get(row["gsis_id"]!) ?? [];
    list.push({
      week: Number(row["week"]),
      kind,
      softTissue: SOFT_TISSUE.some((s) => kind.includes(s)),
    });
    byPlayer.set(row["gsis_id"]!, list);
  }

  return byPlayer;
}
