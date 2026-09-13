/**
 * Prints a projected 2026 regular season for all 32 teams: expected
 * wins, a 10th to 90th percentile win range, division and playoff odds,
 * and the record so far. Two views, one sorted by expected wins and one
 * grouped by division.
 *
 * Run it with `npx tsx scripts/seasonOutlook.ts`, and add `--markdown`
 * for tables that paste into a document. `--season`, `--sims` and
 * `--seed` are there for reruns. It reads games.csv out of data/raw,
 * which `npx tsx scripts/fetchData.ts --seasons 2026 --force` refreshes.
 * The README in this directory says how the rating is built.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import {
  blendRatings,
  DEFAULT_MARGIN_SD,
  DIVISION_NAMES,
  fitMarginRatings,
  fitMarketRatings,
  projectSeason,
  TEAM_CODES,
  TEAMS,
  type Fixture,
  type LineGame,
  type MarginGame,
  type PlayedGame,
  type Ratings,
  type TeamOutlook,
} from "../src/model/seasonOutlook.js";

const RAW_DIR = join(import.meta.dirname, "..", "data", "raw");

/** the market moves faster than last season's scores did */
const MARKET_WEIGHT = 2 / 3;

/**
 * Ridge strengths, in games. The margin fit shrinks about as hard as
 * three average opponents would, which is what keeps a 4-13 team from
 * coming out at 10 points below the league. The line fit is close to
 * unpenalised, so a team with a posted line follows the market and a
 * team without one stays at its margin rating.
 */
const MARGIN_LAMBDA = 6;
const MARKET_LAMBDA = 0.35;

/** a 2026 result says more about this team than a 2025 one does */
const PRIOR_SEASON_WEIGHT = 1;
const THIS_SEASON_WEIGHT = 2.5;

const HOME_FIELD_SEASONS = 3;

interface GameRow {
  season: number;
  week: number;
  gameType: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number | undefined;
  awayScore: number | undefined;
  spreadLine: number | undefined;
  neutralSite: boolean;
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "" || value === "NA") {
    return undefined;
  }

  const n = Number(value);
  return Number.isNaN(n) ? undefined : n;
}

async function loadGameRows(): Promise<GameRow[]> {
  const text = await readFile(join(RAW_DIR, "games.csv"), "utf8");

  return parseCsv(text)
    .filter((row) => TEAMS[row["home_team"] ?? ""] !== undefined)
    .map((row) => ({
      season: toNumber(row["season"]) ?? 0,
      week: toNumber(row["week"]) ?? 0,
      gameType: row["game_type"] ?? "",
      homeTeam: row["home_team"] ?? "",
      awayTeam: row["away_team"] ?? "",
      homeScore: toNumber(row["home_score"]),
      awayScore: toNumber(row["away_score"]),
      spreadLine: toNumber(row["spread_line"]),
      neutralSite: (row["location"] ?? "Home") !== "Home",
    }));
}

function isPlayed(row: GameRow): boolean {
  return row.homeScore !== undefined && row.awayScore !== undefined;
}

/** how many points a home side has been worth lately, in whole games */
function estimateHomeField(rows: GameRow[], through: number): number {
  const first = through - HOME_FIELD_SEASONS + 1;
  let margin = 0;
  let count = 0;

  for (const row of rows) {
    const inWindow = row.season >= first && row.season <= through;

    if (!inWindow || row.gameType !== "REG" || row.neutralSite) {
      continue;
    }

    if (!isPlayed(row)) {
      continue;
    }

    margin += row.homeScore! - row.awayScore!;
    count++;
  }

  if (count === 0) {
    return 2;
  }

  return margin / count;
}

function marginGames(
  rows: GameRow[],
  season: number,
  priorSeason: number,
): MarginGame[] {
  const out: MarginGame[] = [];

  for (const row of rows) {
    if (!isPlayed(row)) {
      continue;
    }

    const weight = weightFor(row, season, priorSeason);

    if (weight === 0) {
      continue;
    }

    out.push({
      homeTeam: row.homeTeam,
      awayTeam: row.awayTeam,
      homeScore: row.homeScore!,
      awayScore: row.awayScore!,
      neutralSite: row.neutralSite,
      weight,
    });
  }

  return out;
}

function weightFor(row: GameRow, season: number, priorSeason: number): number {
  if (row.season === season) {
    return THIS_SEASON_WEIGHT;
  }

  if (row.season === priorSeason) {
    return PRIOR_SEASON_WEIGHT;
  }

  return 0;
}

interface Flags {
  markdown: boolean;
  season: number;
  sims: number;
  seed: number;
}

function readFlags(argv: string[]): Flags {
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);

    if (at === -1) {
      return undefined;
    }

    return argv[at + 1];
  };

  return {
    markdown: argv.includes("--markdown"),
    season: toNumber(value("season")) ?? 2026,
    sims: toNumber(value("sims")) ?? 20000,
    seed: toNumber(value("seed")) ?? 20260913,
  };
}

function formatWins(value: number): string {
  return value.toFixed(1);
}

function formatOdds(value: number): string {
  if (value > 0 && value < 0.005) {
    return "<1%";
  }

  return `${(value * 100).toFixed(0)}%`;
}

function formatRecord(outlook: TeamOutlook): string {
  const base = `${outlook.wins}-${outlook.losses}`;
  return outlook.ties > 0 ? `${base}-${outlook.ties}` : base;
}

const COLUMNS = ["Team", "Rating", "Rec", "Exp W", "10-90", "Div", "Playoff"];

function cellsFor(outlook: TeamOutlook, ratings: Ratings): string[] {
  return [
    outlook.team,
    (ratings[outlook.team] ?? 0).toFixed(1),
    formatRecord(outlook),
    formatWins(outlook.expectedWins),
    `${formatWins(outlook.winLow)} to ${formatWins(outlook.winHigh)}`,
    formatOdds(outlook.divisionOdds),
    formatOdds(outlook.playoffOdds),
  ];
}

function plainTable(rows: string[][]): string {
  const widths = COLUMNS.map((name, i) =>
    Math.max(name.length, ...rows.map((row) => row[i]!.length)),
  );
  const line = (cells: string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd();

  return [
    line(COLUMNS),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map(line),
  ].join("\n");
}

function markdownTable(rows: string[][]): string {
  const body = rows.map((row) => `| ${row.join(" | ")} |`);
  return [
    `| ${COLUMNS.join(" | ")} |`,
    `| ${COLUMNS.map(() => "---").join(" | ")} |`,
    ...body,
  ].join("\n");
}

function heading(text: string, markdown: boolean): string {
  return markdown ? `## ${text}` : text;
}

async function main(): Promise<void> {
  const flags = readFlags(process.argv.slice(2));
  const rows = await loadGameRows();
  const season = flags.season;
  const priorSeason = season - 1;
  const seasonRows = rows.filter(
    (row) => row.season === season && row.gameType === "REG",
  );

  if (seasonRows.length === 0) {
    console.error(`games.csv has no ${season} schedule yet`);
    process.exitCode = 1;
    return;
  }

  const homeField = estimateHomeField(rows, priorSeason);
  const margin = fitMarginRatings(
    marginGames(rows, season, priorSeason),
    homeField,
    MARGIN_LAMBDA,
  );

  const lines: LineGame[] = seasonRows
    .filter((row) => row.spreadLine !== undefined)
    .map((row) => ({
      homeTeam: row.homeTeam,
      awayTeam: row.awayTeam,
      spreadLine: row.spreadLine!,
      neutralSite: row.neutralSite,
    }));
  const market = fitMarketRatings(lines, homeField, MARKET_LAMBDA, margin);
  const ratings = blendRatings(market, margin, MARKET_WEIGHT);

  const played: PlayedGame[] = seasonRows.filter(isPlayed).map((row) => ({
    homeTeam: row.homeTeam,
    awayTeam: row.awayTeam,
    homeScore: row.homeScore!,
    awayScore: row.awayScore!,
    neutralSite: row.neutralSite,
  }));
  const remaining: Fixture[] = seasonRows
    .filter((row) => !isPlayed(row))
    .map((row) => ({
      homeTeam: row.homeTeam,
      awayTeam: row.awayTeam,
      neutralSite: row.neutralSite,
    }));

  const outlooks = projectSeason({
    ratings,
    homeField,
    marginSd: DEFAULT_MARGIN_SD,
    played,
    remaining,
    iterations: flags.sims,
    seed: flags.seed,
  });

  const playedWeeks = [...new Set(seasonRows.filter(isPlayed).map((r) => r.week))]
    .sort((a, b) => a - b);
  const lineWeeks = [
    ...new Set(seasonRows.filter((r) => r.spreadLine !== undefined).map((r) => r.week)),
  ].sort((a, b) => a - b);
  const teamsWithLines = new Set<string>();

  for (const line of lines) {
    teamsWithLines.add(line.homeTeam);
    teamsWithLines.add(line.awayTeam);
  }

  const table = flags.markdown ? markdownTable : plainTable;
  const out: string[] = [];
  out.push(heading(`${season} projected regular season`, flags.markdown));
  out.push("");
  out.push(
    `Weeks counted as played: ${describeWeeks(playedWeeks)}. ` +
      `${played.length} of ${seasonRows.length} games are in the books, and ` +
      `${remaining.length} are simulated ${flags.sims} times.`,
  );
  out.push(
    `Spread lines posted for ${namedWeeks(lineWeeks)}, ` +
      `${lines.length} games covering ${teamsWithLines.size} of 32 teams. ` +
      `Ratings are ${Math.round(MARKET_WEIGHT * 100)}% the line fit and ` +
      `${Math.round((1 - MARKET_WEIGHT) * 100)}% the margin fit over ` +
      `${priorSeason} and ${season}, with home field at ` +
      `${homeField.toFixed(2)} points and a margin sd of ` +
      `${DEFAULT_MARGIN_SD}.`,
  );
  out.push("");
  out.push(heading("By expected wins", flags.markdown));
  out.push("");
  out.push(table(outlooks.map((outlook) => cellsFor(outlook, ratings))));
  out.push("");
  out.push(heading("By division", flags.markdown));

  for (const conference of ["AFC", "NFC"] as const) {
    for (const division of DIVISION_NAMES) {
      const group = outlooks.filter(
        (outlook) =>
          outlook.conference === conference && outlook.division === division,
      );
      out.push("");
      out.push(
        flags.markdown
          ? `### ${conference} ${division}`
          : `${conference} ${division}`,
      );
      out.push("");
      out.push(table(group.map((outlook) => cellsFor(outlook, ratings))));
    }
  }

  out.push("");
  out.push(heading("Ratings, high to low", flags.markdown));
  out.push("");
  out.push(ratingLines(ratings, market, margin).join("\n"));
  console.log(out.join("\n"));
}

function describeWeeks(weeks: number[]): string {
  if (weeks.length === 0) {
    return "none";
  }

  if (weeks.length === 1) {
    return `${weeks[0]}`;
  }

  return `${weeks[0]} to ${weeks[weeks.length - 1]}`;
}

function namedWeeks(weeks: number[]): string {
  if (weeks.length === 1) {
    return `week ${weeks[0]}`;
  }

  return `weeks ${describeWeeks(weeks)}`;
}

function ratingLines(
  blended: Ratings,
  market: Ratings,
  margin: Ratings,
): string[] {
  const sorted = [...TEAM_CODES].sort(
    (a, b) => (blended[b] ?? 0) - (blended[a] ?? 0),
  );

  return sorted.map((team, i) => {
    const rank = `${i + 1}`.padStart(2);
    const blend = (blended[team] ?? 0).toFixed(1).padStart(5);
    const line = (market[team] ?? 0).toFixed(1).padStart(5);
    const scores = (margin[team] ?? 0).toFixed(1).padStart(5);
    return `${rank}. ${team.padEnd(3)} ${blend}  (lines ${line}, margins ${scores})`;
  });
}

await main();
