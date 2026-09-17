/**
 * Fits and measures the weekly kicker line the slate ships.
 *
 * Every kicker week since 2022 is read as three numbers: what he has
 * paid over his own recent weeks, what the line expects his side to
 * score, and how willing a staff at that ground is to send him out. The
 * rivals are his own season average, the league's average kicker and
 * the board's season number divided out. The ceiling is an oracle that
 * knew the week.
 *
 * Run: npx tsx scripts/kickerWeekEval.ts [--seasons 2022,2023,2024,2025]
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadKickerWeeks, type KickerWeek } from "../src/data/nflverse.js";
import {
  KICKER_PARTS, payKicker, projectKickerWeek, STANDARD_KICKER_PAYS,
  TRAILING_WEEKS, type Parts,
} from "../src/features/kickerWeek.js";
import type { Venue } from "../src/features/kickingVenue.js";
import { parseCsv } from "../src/data/csv.js";

const RAW = join(import.meta.dirname, "..", "data", "raw");

/** what the line expects a side to score where a fixture has no line */
const IMPLIED_WITHOUT_A_LINE = 22.3;

const pay = (parts: Parts) => payKicker(parts, STANDARD_KICKER_PAYS);

interface Fixture {
  implied: number;
  venue: Venue;
}

/** each side's expected points and ground, keyed season, week and club */
function fixturesFrom(rows: Record<string, string>[]): Map<string, Fixture> {
  const out = new Map<string, Fixture>();

  for (const row of rows) {
    if (row["game_type"] !== "REG") {
      continue;
    }

    const roof = row["roof"] ?? "";
    const venue: Venue = roof === "outdoors" || roof === "open"
      ? {
          indoors: false,
          temperature: Number(row["temp"]) || 60,
          wind: Number(row["wind"]) || 0,
        }
      : { indoors: true };
    const total = Number(row["total_line"]);
    const spread = Number(row["spread_line"]);
    const at = (team: string) =>
      `${row["season"]}|${row["week"]}|${team}`;
    const known = Number.isFinite(total) && Number.isFinite(spread);

    out.set(at(row["home_team"] ?? ""), {
      implied: known ? total / 2 - spread / 2 : IMPLIED_WITHOUT_A_LINE,
      venue,
    });
    out.set(at(row["away_team"] ?? ""), {
      implied: known ? total / 2 + spread / 2 : IMPLIED_WITHOUT_A_LINE,
      venue,
    });
  }

  return out;
}

interface Row {
  season: number;
  week: number;
  /** what he had paid a game over his recent weeks, or last season */
  trailing: number;
  implied: number;
  venue: Venue;
  ownParts: Parts;
  ownGames: number;
  lastYearPaid: number;
  /** his own average across the whole season, which is hindsight */
  seasonAverage: number;
  was: number;
}

/** his parts a game over the weeks given */
function ratesOver(weeks: KickerWeek[]): Parts {
  const out: Parts = {};

  for (const part of KICKER_PARTS) {
    out[part] = weeks.reduce((sum, w) => sum + (w.parts[part] ?? 0), 0) /
      Math.max(1, weeks.length);
  }

  return out;
}

async function rowsFor(
  season: number, fixtures: Map<string, Fixture>,
): Promise<Row[]> {
  const weeks = await loadKickerWeeks(season);
  const before = await loadKickerWeeks(season - 1);
  const lastYear = new Map<string, { paid: number; games: number }>();

  for (const w of before) {
    const so = lastYear.get(w.playerId) ?? { paid: 0, games: 0 };
    so.paid += pay(w.parts);
    so.games++;
    lastYear.set(w.playerId, so);
  }

  const byPlayer = new Map<string, KickerWeek[]>();

  for (const w of weeks) {
    byPlayer.set(w.playerId, [...(byPlayer.get(w.playerId) ?? []), w]);
  }

  const out: Row[] = [];

  for (const [playerId, his] of byPlayer) {
    const sorted = [...his].sort((a, b) => a.week - b.week);
    const seasonAverage = sorted.reduce((s, w) => s + pay(w.parts), 0) /
      sorted.length;
    const year = lastYear.get(playerId);

    for (let at = 0; at < sorted.length; at++) {
      const week = sorted[at]!;
      const fixture = fixtures.get(`${season}|${week.week}|${week.teamId}`);

      if (!fixture) {
        continue;
      }

      const own = sorted.slice(Math.max(0, at - TRAILING_WEEKS), at);
      const lastYearPaid = year && year.games >= 6
        ? year.paid / year.games
        : 8.1;

      out.push({
        season,
        week: week.week,
        trailing: own.length
          ? own.reduce((s, w) => s + pay(w.parts), 0) / own.length
          : lastYearPaid,
        implied: fixture.implied,
        venue: fixture.venue,
        ownParts: ratesOver(own),
        ownGames: own.length,
        lastYearPaid,
        seasonAverage,
        was: pay(week.parts),
      });
    }
  }

  return out;
}

/** least squares on the three columns the line reads */
function fit(rows: Row[]): number[] {
  const columns = (row: Row) => [1, row.trailing, row.implied];
  const width = 3;
  const left = Array.from({ length: width }, () => new Array(width).fill(0));
  const right = new Array(width).fill(0);

  for (const row of rows) {
    const x = columns(row);

    for (let i = 0; i < width; i++) {
      right[i] += x[i]! * row.was;

      for (let j = 0; j < width; j++) {
        left[i]![j] += x[i]! * x[j]!;
      }
    }
  }

  // Gaussian elimination, which is plenty at three columns
  for (let i = 0; i < width; i++) {
    const pivot = left[i]![i]!;

    for (let j = i; j < width; j++) {
      left[i]![j] = left[i]![j]! / pivot;
    }

    right[i] = right[i]! / pivot;

    for (let k = 0; k < width; k++) {
      if (k === i) {
        continue;
      }

      const factor = left[k]![i]!;

      for (let j = i; j < width; j++) {
        left[k]![j] = left[k]![j]! - factor * left[i]![j]!;
      }

      right[k] = right[k]! - factor * right[i]!;
    }
  }

  return right;
}

function errors(pairs: [number, number][]): { mae: number; corr: number } {
  const mae = pairs.reduce((s, [said, was]) => s + Math.abs(said - was), 0) /
    Math.max(1, pairs.length);
  const mean = (at: 0 | 1) =>
    pairs.reduce((s, p) => s + p[at], 0) / Math.max(1, pairs.length);
  const [mx, my] = [mean(0), mean(1)];
  let top = 0;
  let leftSq = 0;
  let rightSq = 0;

  for (const [said, was] of pairs) {
    top += (said - mx) * (was - my);
    leftSq += (said - mx) ** 2;
    rightSq += (was - my) ** 2;
  }

  const under = Math.sqrt(leftSq * rightSq);

  return { mae, corr: under > 0 ? top / under : 0 };
}

const lineFor = (row: Row) => projectKickerWeek({
  ownPaid: [],
  lastYearPaid: row.trailing,
  ownParts: row.ownParts,
  ownGames: row.ownGames,
  impliedFor: row.implied,
  venue: row.venue,
}).paid;

async function main(): Promise<void> {
  const flag = process.argv.indexOf("--seasons");
  const seasons = flag === -1
    ? [2022, 2023, 2024, 2025]
    : process.argv[flag + 1]!.split(",").map(Number);
  const fixtures = fixturesFrom(
    parseCsv(await readFile(join(RAW, "games.csv"), "utf8")));
  const rows: Row[] = [];

  for (const season of seasons) {
    rows.push(...await rowsFor(season, fixtures));
  }

  console.log(`${rows.length} kicker weeks over ${seasons.join(", ")}`);

  const [base, perOwn, perImplied] = fit(rows);
  console.log(
    `fitted on all of them: base ${base!.toFixed(4)}, ` +
    `per own recent ${perOwn!.toFixed(4)}, ` +
    `per implied ${perImplied!.toFixed(4)}`,
  );

  /**
   * Each season predicted by weights the other seasons fitted, so the
   * numbers below are not the fit reading its own training set.
   */
  const heldOut: [number, number][] = [];

  for (const season of seasons) {
    const others = rows.filter((r) => r.season !== season);
    const [b, o, i] = fit(others);

    for (const row of rows.filter((r) => r.season === season)) {
      heldOut.push([b! + o! * row.trailing + i! * row.implied, row.was]);
    }
  }

  const poolMean = rows.reduce((s, r) => s + r.was, 0) / rows.length;
  const table: [string, [number, number][]][] = [
    ["the shipped line", rows.map((r) => [lineFor(r), r.was])],
    ["the fit, held out", heldOut],
    ["his own recent weeks", rows.map((r) => [r.trailing, r.was])],
    ["the mean kicker", rows.map((r) => [poolMean, r.was])],
    ["his own season, hindsight", rows.map((r) => [r.seasonAverage, r.was])],
    ["an oracle", rows.map((r) => [r.was, r.was])],
  ];

  console.log(
    `\nwhat each column says on its own: own recent weeks ` +
    `${errors(rows.map((r) => [r.trailing, r.was])).corr.toFixed(3)}, ` +
    `implied for his side ` +
    `${errors(rows.map((r) => [r.implied, r.was])).corr.toFixed(3)}, ` +
    `indoors ` +
    `${errors(rows.map((r) => [r.venue.indoors ? 1 : 0, r.was])).corr.toFixed(3)}`,
  );
  console.log(`\nweeks averaging ${poolMean.toFixed(2)} points\n`);
  console.log("method                       MAE    corr");

  for (const [what, pairs] of table) {
    const { mae, corr } = errors(pairs);
    console.log(
      `${what.padEnd(26)} ${mae.toFixed(2).padStart(5)}  ` +
      `${corr.toFixed(3).padStart(6)}`,
    );
  }

  const league: Parts = {};

  for (const part of KICKER_PARTS) {
    league[part] = Number(
      (rows.reduce((s, r) => s + (r.ownParts[part] ?? 0) * (r.ownGames > 0 ? 1 : 0), 0) /
        Math.max(1, rows.filter((r) => r.ownGames > 0).length)).toFixed(4),
    );
  }

  console.log("\nwhat a kicker counted a game, for the league rates:");
  console.log(JSON.stringify(league));
}

void main();
