import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "./csv.js";
import { RAW_DIR } from "./nflverse.js";

/**
 * Weeks a player appeared on the injury report with his practice or
 * game status limited. A player who suits up while listed is playing
 * hurt, which is the case the season model cannot otherwise see.
 */
export async function loadCompromisedWeeks(
  season: number,
): Promise<Set<string>> {
  const text = await readFile(
    join(RAW_DIR, `injuries_${season}.csv`),
    "utf8",
  ).catch(() => "");

  if (!text) {
    return new Set();
  }

  const compromised = new Set<string>();

  for (const row of parseCsv(text)) {
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

export interface InjuryWeek {
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
  const text = await readFile(
    join(RAW_DIR, `injuries_${season}.csv`),
    "utf8",
  ).catch(() => "");
  const byPlayer = new Map<string, InjuryWeek[]>();

  if (!text) {
    return byPlayer;
  }

  for (const row of parseCsv(text)) {
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
