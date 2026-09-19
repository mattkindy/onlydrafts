/**
 * How often does a player on the injury report play, and what does he
 * score when he does? Over the regular seasons 2018 to 2025, for the
 * positions a lineup starts. He counts as having played if he has a
 * stat row that week or a snap on his side's snap counts.
 *
 * Four rules for the chance he plays are scored by Brier score: the app
 * today, Matt's priors, the rates by status, and the rates by status and
 * practice. The last two are fitted on 2018 to 2022 and scored on 2023
 * to 2025, against a ceiling of those seasons' own rates.
 *
 * Run: npx tsx scripts/injuryStatusEval.ts [--seasons 2018-2025]
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseCsv } from "../src/data/csv.js";
import { normalizeName } from "../src/data/names.js";
import {
  loadPlayerStats, loadSnapCounts, RAW_DIR,
} from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { seasonsAsked } from "../src/data/seasons.js";

const POSITIONS = ["QB", "RB", "WR", "TE", "K"];
const STATUSES = ["Out", "Doubtful", "Questionable"];

/** what the report calls a practice, shortened to what fits a table */
const PRACTICE: Record<string, string> = {
  "Did Not Participate In Practice": "DNP",
  "Limited Participation in Practice": "Limited",
  "Full Participation in Practice": "Full",
};

/** the seasons the measured rules are fitted on, and the ones they are scored on */
const FIT_SEASONS = [2018, 2019, 2020, 2021, 2022];
const SCORE_SEASONS = [2023, 2024, 2025];

interface Listing {
  season: number;
  week: number;
  playerId: string;
  name: string;
  position: string;
  status: string;
  practice: string;
  played: boolean;
  points: number;
}

interface Kicking {
  made: number;
  attempts: number;
  longMade: number;
  extraPoints: number;
}

/**
 * A kicker's points are not in the stat line the scoring rules take, so
 * his figures are counted here under the usual 3 and 1 with the long ones
 * paying more.
 */
function kickerPoints(kicking: Kicking): number {
  const short = kicking.made - kicking.longMade;

  return short * 3 + kicking.longMade * 5 + kicking.extraPoints -
    (kicking.attempts - kicking.made);
}

interface Scorable {
  position: string;
  statLine: Parameters<typeof fantasyPoints>[0];
  kicking: Kicking;
}

const pointsOf = (row: Scorable) =>
  row.position === "K"
    ? kickerPoints(row.kicking)
    : fantasyPoints(row.statLine, presets.half);

async function loadListings(season: number): Promise<Listing[]> {
  const text = await readFile(join(RAW_DIR, `injuries_${season}.csv`), "utf8");
  const rows = parseCsv(text);
  const stats = await loadPlayerStats(season);
  const snaps = await loadSnapCounts(season);

  const pointsBy = new Map<string, number>();

  for (const row of stats) {
    pointsBy.set(`${row.playerId}|${row.week}`, pointsOf(row));
  }

  const snapped = new Set(
    snaps
      .filter((row) => row.offensePct > 0)
      .map((row) => `${normalizeName(row.playerName)}|${row.week}`),
  );

  // a player has a row per report and the last one is the ruling that stood
  const last = new Map<string, Record<string, string>>();

  for (const row of rows) {
    if (row["game_type"] !== "REG") {
      continue;
    }

    if (!POSITIONS.includes(row["position"] ?? "")) {
      continue;
    }

    if (!STATUSES.includes(row["report_status"] ?? "")) {
      continue;
    }

    last.set(`${row["gsis_id"]}|${row["week"]}`, row);
  }

  return [...last.values()].map((row) => {
    const week = Number(row["week"]);
    const playerId = row["gsis_id"] ?? "";
    const name = row["full_name"] ?? "";
    const key = `${playerId}|${week}`;

    return {
      season,
      week,
      playerId,
      name,
      position: row["position"] ?? "",
      status: row["report_status"] ?? "",
      practice: PRACTICE[row["practice_status"] ?? ""] ?? "",
      played: pointsBy.has(key) || snapped.has(`${normalizeName(name)}|${week}`),
      points: pointsBy.get(key) ?? 0,
    };
  });
}

/**
 * His played weeks that nothing on the report touched, which is what a
 * week on the report is compared against. A player whose every week came
 * with a listing has no baseline and is left out of the ratio.
 */
async function baselines(
  season: number, listings: Listing[],
): Promise<Map<string, number>> {
  const stats = await loadPlayerStats(season);
  const listedWeeks = new Set(
    listings.map((his) => `${his.playerId}|${his.week}`),
  );

  const unlisted = new Map<string, number[]>();

  for (const row of stats) {
    if (listedWeeks.has(`${row.playerId}|${row.week}`)) {
      continue;
    }

    const had = unlisted.get(row.playerId) ?? [];

    had.push(pointsOf(row));
    unlisted.set(row.playerId, had);
  }

  const average = new Map<string, number>();

  for (const [playerId, weeks] of unlisted) {
    // one or two weeks is too thin a baseline to divide anybody by
    if (weeks.length < 3) {
      continue;
    }

    average.set(playerId, weeks.reduce((a, b) => a + b, 0) / weeks.length);
  }

  return average;
}

/* ---------- the rules ---------- */

type Rule = (his: Listing) => number;

/** the app today: a player not marked Out is worth his full projection */
const APP_TODAY: Record<string, number> = {
  Out: 0, Doubtful: 1, Questionable: 1,
};

/** what Matt would have guessed before anybody counted */
const PRIORS: Record<string, number> = {
  Out: 0, Doubtful: 0, Questionable: 0.6,
};

const byTable = (table: Record<string, number>): Rule =>
  (his) => table[his.status] ?? 1;

/** the share of a group that played */
function rateOf(listings: Listing[]): number {
  if (!listings.length) {
    return 0;
  }

  return listings.filter((his) => his.played).length / listings.length;
}

function ratesByStatus(listings: Listing[]): Record<string, number> {
  const table: Record<string, number> = {};

  for (const status of STATUSES) {
    table[status] = rateOf(listings.filter((his) => his.status === status));
  }

  return table;
}

function ratesByPractice(listings: Listing[]): Record<string, number> {
  const table: Record<string, number> = {};

  for (const status of STATUSES) {
    for (const practice of ["DNP", "Limited", "Full", ""]) {
      const group = listings.filter(
        (his) => his.status === status && his.practice === practice,
      );

      // a thin cell falls back to the status on its own at scoring time
      if (group.length >= 50) {
        table[`${status}|${practice}`] = rateOf(group);
      }
    }
  }

  return table;
}

const byPractice = (
  practiceRates: Record<string, number>, statusRates: Record<string, number>,
): Rule =>
  (his) =>
    practiceRates[`${his.status}|${his.practice}`] ??
      statusRates[his.status] ?? 1;

function brier(listings: Listing[], rule: Rule): number {
  const total = listings.reduce((sum, his) => {
    const said = rule(his);
    const was = his.played ? 1 : 0;

    return sum + (said - was) ** 2;
  }, 0);

  return total / listings.length;
}

/* ---------- printing ---------- */

const pct = (v: number) => (v * 100).toFixed(1) + "%";

const PRACTICES = ["DNP", "Limited", "Full", "(none)"];

function practiceTable(listings: Listing[], status: string) {
  console.log(`\n## ${status}, by practice participation\n`);
  console.log("practice   listings  played");

  for (const practice of PRACTICES) {
    const want = practice === "(none)" ? "" : practice;
    const group = listings.filter(
      (his) => his.status === status && his.practice === want,
    );

    console.log(
      practice.padEnd(11) + String(group.length).padStart(8) +
        rateOf(group).toFixed(3).padStart(8),
    );
  }
}

function playRateTable(listings: Listing[]) {
  console.log("\n## Who played, by status\n");
  console.log("status         listings  played");

  for (const status of STATUSES) {
    const group = listings.filter((his) => his.status === status);

    console.log(
      status.padEnd(15) + String(group.length).padStart(8) +
        rateOf(group).toFixed(3).padStart(8),
    );
  }

  console.log("\n## By position\n");
  console.log("pos  " + STATUSES.map((s) => s.padStart(14)).join(""));

  for (const position of POSITIONS) {
    const at = listings.filter((his) => his.position === position);
    const cells = STATUSES.map((status) => {
      const group = at.filter((his) => his.status === status);

      return `${rateOf(group).toFixed(2)} (${group.length})`.padStart(14);
    });

    console.log(position.padEnd(5) + cells.join(""));
  }

  practiceTable(listings, "Questionable");
  practiceTable(listings, "Doubtful");
}

function pointsTable(listings: Listing[], against: Map<string, number>) {
  console.log(
    "\n## What he scored when he played, against his own other weeks\n",
  );
  console.log("status         played  ratio  his points  usually");

  for (const status of STATUSES) {
    const group = listings.filter(
      (his) => his.played && his.status === status &&
        (against.get(`${his.season}|${his.playerId}`) ?? 0) > 1,
    );

    if (!group.length) {
      console.log(status.padEnd(15) + "0".padStart(7));

      continue;
    }

    const his = group.reduce((sum, one) => sum + one.points, 0) / group.length;
    const usually = group.reduce(
      (sum, one) => sum + against.get(`${one.season}|${one.playerId}`)!, 0,
    ) / group.length;

    console.log(
      status.padEnd(15) + String(group.length).padStart(7) +
        (his / usually).toFixed(3).padStart(7) +
        his.toFixed(1).padStart(12) + usually.toFixed(1).padStart(9),
    );
  }
}

function scoreRules(fit: Listing[], scored: Listing[]) {
  const fitted = ratesByStatus(fit);
  const fittedPractice = ratesByPractice(fit);
  const inSample = ratesByStatus(scored);

  console.log(
    `\n## Chance he plays, scored on ${SCORE_SEASONS.join(", ")} ` +
      `(${scored.length} listings)\n`,
  );
  console.log("rule                                    brier");

  const rules: [string, Rule][] = [
    ["A  the app today (Q 1.00, D 1.00)", byTable(APP_TODAY)],
    ["B  priors (Q 0.60, D 0.00)", byTable(PRIORS)],
    [
      `C  measured by status (Q ${(fitted.Questionable ?? 0).toFixed(2)}, ` +
        `D ${(fitted.Doubtful ?? 0).toFixed(2)})`,
      byTable(fitted),
    ],
    ["D  measured by status and practice", byPractice(fittedPractice, fitted)],
    ["   ceiling: the same seasons' own rates", byTable(inSample)],
  ];

  for (const [name, rule] of rules) {
    console.log(name.padEnd(40) + brier(scored, rule).toFixed(4));
  }

  console.log("\n## The rates C and D were fitted on\n");

  for (const status of STATUSES) {
    console.log(status.padEnd(26) + pct(fitted[status] ?? 0));
  }

  for (const [key, rate] of Object.entries(fittedPractice)) {
    console.log(key.padEnd(26) + pct(rate));
  }
}

async function main() {
  const seasons = seasonsAsked(
    process.argv.slice(2),
    [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
  );

  const listings: Listing[] = [];
  const against = new Map<string, number>();

  for (const season of seasons) {
    const his = await loadListings(season);

    listings.push(...his);

    for (const [playerId, average] of await baselines(season, his)) {
      against.set(`${season}|${playerId}`, average);
    }
  }

  console.log(
    "# Injury report status against what happened, " +
      `${seasons[0]} to ${seasons[seasons.length - 1]}\n`,
  );
  console.log(`${listings.length} listings over ${seasons.length} seasons.`);

  playRateTable(listings);
  pointsTable(listings, against);

  const fit = listings.filter((his) => FIT_SEASONS.includes(his.season));
  const scored = listings.filter((his) => SCORE_SEASONS.includes(his.season));

  if (!fit.length || !scored.length) {
    console.log("\nNo split to score: ask for seasons on both sides of 2023.");

    return;
  }

  scoreRules(fit, scored);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
