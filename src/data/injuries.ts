import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "./csv.js";
import { RAW_DIR, type GameRow } from "./nflverse.js";

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

/**
 * Sleeper's injury status for every player who has one, as it stood when
 * the weekly refresh last ran. The file only ever has the one week the
 * refresh was building for.
 */
export const SLEEPER_STATUS_PATH = join(
  RAW_DIR,
  "..",
  "curated",
  "sleeperStatus.csv",
);

export interface SleeperStatus {
  season: number;
  /** the week the refresh was building for when it took the snapshot */
  week: number;
  gsisId: string;
  /** his club as Sleeper spells it */
  team: string;
  /** Sleeper's own word: Out, Doubtful, Questionable, IR, PUP, Sus and so on */
  status: string;
  /** when the snapshot was taken, as an ISO time */
  fetchedAt: string;
}

export function sleeperStatusToCsv(rows: SleeperStatus[]): string {
  const lines = [...rows]
    .sort((a, b) => a.gsisId.localeCompare(b.gsisId))
    .map((r) =>
      [r.season, r.week, r.gsisId, r.team, r.status, r.fetchedAt].join(","));

  return ["season,week,gsisId,team,status,fetchedAt", ...lines].join("\n") +
    "\n";
}

export function parseSleeperStatus(text: string): SleeperStatus[] {
  return parseCsv(text)
    .filter((row) => row["gsisId"] && row["status"])
    .map((row) => ({
      season: Number(row["season"]),
      week: Number(row["week"]),
      gsisId: row["gsisId"] ?? "",
      team: row["team"] ?? "",
      status: row["status"] ?? "",
      fetchedAt: row["fetchedAt"] ?? "",
    }));
}

/**
 * The clubs whose game in the week was played on a day before `today`, as
 * YYYY-MM-DD. A status Sleeper shows the day after a Thursday game is about
 * what happened in it, so it says nothing about who was going to play.
 */
export function teamsAlreadyPlayed(
  games: GameRow[], season: number, week: number, today: string,
): Set<string> {
  const played = new Set<string>();

  for (const game of games) {
    if (game.season !== season || game.week !== week) {
      continue;
    }

    if (!game.gameday || game.gameday >= today) {
      continue;
    }

    played.add(game.homeTeamId);
    played.add(game.awayTeamId);
  }

  return played;
}

/** the snapshot, or no rows on a checkout that has never fetched one */
export async function loadSleeperStatus(): Promise<SleeperStatus[]> {
  return parseSleeperStatus(
    await readFile(SLEEPER_STATUS_PATH, "utf8").catch(() => ""),
  );
}

const statusKeys = (rows: SleeperStatus[]) =>
  new Set(rows.map((r) =>
    `${r.season}|${r.week}|${r.gsisId}|${r.team}|${r.status}`));

/**
 * Whether two snapshots list the same players with the same words for the
 * same week. The refresh leaves the file alone when nothing moved, so a run
 * with no news has nothing new to commit.
 */
export function sameSleeperStatus(
  a: SleeperStatus[], b: SleeperStatus[],
): boolean {
  const before = statusKeys(a);
  const after = statusKeys(b);

  return before.size === after.size && [...after].every((k) => before.has(k));
}

/** whether a player is expected to sit, or to play with a markdown */
export interface WeekCall {
  out: boolean;
  questionable: boolean;
  /** the word the call came from, as its source spells it */
  report: string;
  source: "report" | "sleeper";
}

type Reading = Pick<WeekCall, "out" | "questionable">;

const READS_OUT: Reading = { out: true, questionable: false };
const READS_QUESTIONABLE: Reading = { out: false, questionable: true };
const READS_CLEAR: Reading = { out: false, questionable: false };

// a doubtful player almost never takes the field, so he counts as out
const REPORT_WORDS = new Map<string, Reading>([
  ["Out", READS_OUT],
  ["Doubtful", READS_OUT],
  ["Questionable", READS_QUESTIONABLE],
]);

// a player on a reserve list or suspended is off the active roster, so his
// club never lists him on the weekly report and only Sleeper says so
const SLEEPER_WORDS = new Map<string, Reading>([
  ...REPORT_WORDS,
  ["IR", READS_OUT],
  ["PUP", READS_OUT],
  ["Sus", READS_OUT],
]);

/** what a club's final report status says about whether he plays */
export function readReportStatus(word: string): Reading {
  return { ...(REPORT_WORDS.get(word.trim()) ?? READS_CLEAR) };
}

/**
 * gsis id -> the status a club filed on its final report for the week. A
 * row with the status blank is a practice report filed before the club
 * has ruled anybody in or out, so it is left out.
 */
export function finalReportFor(
  rows: Record<string, string>[], week: number,
): Map<string, string> {
  const filed = new Map<string, string>();

  for (const row of rows) {
    const playerId = (row["gsis_id"] ?? "").trim();
    const word = (row["report_status"] ?? "").trim();

    if (Number(row["week"]) !== week || !playerId || !word) {
      continue;
    }

    filed.set(playerId, word);
  }

  return filed;
}

/**
 * Who is out and who is questionable for one week. A club's final report
 * is the last word for any player it lists. Until a club files it, which
 * for most clubs is Friday, Sleeper's status is used instead, because
 * Sleeper updates it as soon as the practice news comes out. A snapshot
 * taken for another season or week says nothing about this one.
 */
export function mergeWeekStatus(
  season: number,
  week: number,
  finalReport: Map<string, string>,
  snapshot: SleeperStatus[],
): Map<string, WeekCall> {
  const calls = new Map<string, WeekCall>();

  for (const [playerId, word] of finalReport) {
    calls.set(playerId, {
      ...readReportStatus(word), report: word, source: "report",
    });
  }

  for (const row of snapshot) {
    if (row.season !== season || row.week !== week || calls.has(row.gsisId)) {
      continue;
    }

    const reading = SLEEPER_WORDS.get(row.status);

    if (!reading) {
      continue;
    }

    calls.set(row.gsisId, { ...reading, report: row.status, source: "sleeper" });
  }

  return calls;
}

/** the week's calls, from the nflverse report and the Sleeper snapshot */
export async function loadWeekStatus(
  season: number, week: number,
): Promise<Map<string, WeekCall>> {
  const [rows, snapshot] = await Promise.all([
    loadInjuryRows(season),
    loadSleeperStatus(),
  ]);

  return mergeWeekStatus(season, week, finalReportFor(rows, week), snapshot);
}
