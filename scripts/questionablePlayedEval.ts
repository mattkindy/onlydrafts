/**
 * Whether the 0.86 markdown injuryStatusEval.ts found for a questionable
 * player who plays belongs on our own weekly line, Sleeper's, both or
 * neither.
 *
 * For every season data/curated/sleeperWeekly.csv covers, every QB, RB, WR
 * and TE the injury report called Questionable who then had a stat row is
 * scored PPR against our own weekly ridge, Sleeper's cached number, and a
 * control group of players nobody listed that same week. A best single
 * factor is fit on the earlier covered seasons and scored on the later.
 *
 * Run: npx tsx scripts/questionablePlayedEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseCsv } from "../src/data/csv.js";
import { loadGames, loadPlayerStats, RAW_DIR } from "../src/data/nflverse.js";
import { fantasyPoints, scoringRules } from "../src/scoring/fantasyPoints.js";
import {
  weeklyExamplesForSeason, weeklyProspectiveForWeek, type WeeklySettings,
} from "../src/features/weeklyModel.js";
import { SHIPPED_WINDOWS, type WeeklyExample } from "../src/features/weekly.js";
import {
  fitWeeklyByPosition, predictWeeklyByPosition, type WeeklyByPosition,
} from "../src/features/fitWeeklyByPosition.js";
import {
  loadSleeperWeekly, projectionKey,
} from "../src/data/sleeperProjections.js";

const POSITIONS = ["QB", "RB", "WR", "TE"];
const TRAIN_FROM = 2016;
const PPR = scoringRules("ppr");

/** the shipped ridge's own settings, with no shrink toward last season */
const RAW: WeeklySettings = { windows: SHIPPED_WINDOWS, priorGames: 0 };

/** what the injury report calls a practice, shortened to a table key */
const PRACTICE: Record<string, string> = {
  "Did Not Participate In Practice": "DNP",
  "Limited Participation in Practice": "Limited",
  "Full Participation in Practice": "Full",
};

/** the finding this script is checking, from injuryStatusEval.ts */
const FOUND_FACTOR = 0.86;

interface Item {
  season: number;
  week: number;
  playerId: string;
  position: string;
  practice: string;
}

interface Played extends Item {
  actual: number;
  ours: number;
  sleeper: number;
}

/* ---------- reading the injury reports ---------- */

interface Listings {
  questionable: Item[];
  /** every player-week the report named, at any status, for the control filter */
  listedAny: Set<string>;
}

async function loadListings(season: number): Promise<Listings> {
  const text = await readFile(
    join(RAW_DIR, `injuries_${season}.csv`), "utf8",
  ).catch(() => "");
  const rows = parseCsv(text);

  // a player has a row per report and the last one is the ruling that stood
  const last = new Map<string, Record<string, string>>();

  for (const row of rows) {
    if (row["game_type"] !== "REG") {
      continue;
    }

    if (!POSITIONS.includes(row["position"] ?? "")) {
      continue;
    }

    last.set(`${row["gsis_id"]}|${row["week"]}`, row);
  }

  const questionable: Item[] = [];
  const listedAny = new Set<string>();

  for (const [key, row] of last) {
    const week = Number(row["week"]);
    const playerId = row["gsis_id"] ?? "";

    listedAny.add(`${season}|${week}|${playerId}`);

    if (row["report_status"] !== "Questionable") {
      continue;
    }

    questionable.push({
      season,
      week,
      playerId,
      position: row["position"] ?? "",
      practice: PRACTICE[row["practice_status"] ?? ""] ?? "",
    });
  }

  return { questionable, listedAny };
}

/* ---------- our own past weekly line ---------- */

/** a ridge fit the way the shipped one is, on every season before this one */
async function ourModelFor(
  season: number, games: Awaited<ReturnType<typeof loadGames>>,
): Promise<WeeklyByPosition> {
  const rows: WeeklyExample[] = [];

  for (let s = TRAIN_FROM; s < season; s++) {
    rows.push(...await weeklyExamplesForSeason(s, games, RAW).catch(() => []));
  }

  return fitWeeklyByPosition(rows);
}

async function main() {
  const games = await loadGames();
  const sleeper = await loadSleeperWeekly();
  const seasons = [...new Set([...sleeper.values()].map((p) => p.season))]
    .sort((a, b) => a - b);

  console.log(`Sleeper's cache covers ${seasons.join(", ")}.\n`);

  const half = Math.max(1, Math.floor(seasons.length / 2));
  const fitSeasons = seasons.slice(0, half);
  const scoreSeasons = seasons.slice(half);

  console.log(
    `Fit the factor on ${fitSeasons.join(", ")}, score it on ` +
      `${scoreSeasons.join(", ")}.\n`,
  );

  const models = new Map<number, WeeklyByPosition>();
  const listings = new Map<number, Listings>();
  const actualBy = new Map<string, number>();
  const playedBySeasonWeek = new Map<string, Item[]>();

  for (const season of seasons) {
    models.set(season, await ourModelFor(season, games));
    listings.set(season, await loadListings(season));

    for (const row of await loadPlayerStats(season)) {
      if (!POSITIONS.includes(row.position)) {
        continue;
      }

      actualBy.set(
        `${season}|${row.week}|${row.playerId}`,
        fantasyPoints(row.statLine, PPR),
      );

      const key = `${season}|${row.week}`;
      const at = playedBySeasonWeek.get(key) ?? [];
      at.push({
        season, week: row.week, playerId: row.playerId,
        position: row.position, practice: "",
      });
      playedBySeasonWeek.set(key, at);
    }
  }

  // one weekly ridge row per season-week, joined by playerId when it is asked for
  const rawRowsCache = new Map<string, Map<string, WeeklyExample>>();

  async function rawRowsFor(
    season: number, week: number,
  ): Promise<Map<string, WeeklyExample>> {
    const key = `${season}|${week}`;
    const held = rawRowsCache.get(key);

    if (held) {
      return held;
    }

    const rows = await weeklyProspectiveForWeek(season, week, games, RAW);
    const byPlayer = new Map(rows.map((r) => [r.playerId, r]));
    rawRowsCache.set(key, byPlayer);
    return byPlayer;
  }

  async function gather(items: Item[]): Promise<Played[]> {
    const out: Played[] = [];

    for (const item of items) {
      const actual = actualBy.get(
        `${item.season}|${item.week}|${item.playerId}`,
      );

      if (actual === undefined) {
        continue;
      }

      const raw = (await rawRowsFor(item.season, item.week))
        .get(item.playerId);

      if (!raw) {
        continue;
      }

      const said = sleeper.get(
        projectionKey(item.season, item.week, item.playerId),
      );

      if (!said) {
        continue;
      }

      out.push({
        ...item,
        actual,
        ours: predictWeeklyByPosition(models.get(item.season)!, raw),
        sleeper: said.points,
      });
    }

    return out;
  }

  const questionable = seasons.flatMap((s) => listings.get(s)!.questionable);
  const qPlayed = await gather(questionable);

  const qWeeks = new Set(qPlayed.map((p) => `${p.season}|${p.week}`));
  const controlItems = [...qWeeks].flatMap((key) => {
    const [season, week] = key.split("|").map(Number);
    const listedAny = listings.get(season!)!.listedAny;

    return (playedBySeasonWeek.get(key) ?? []).filter(
      (row) => !listedAny.has(`${row.season}|${row.week}|${row.playerId}`),
    );
  });
  const control = await gather(controlItems);

  console.log(
    `${qPlayed.length} questionable listings played and matched to both ` +
      `lines; ${control.length} unlisted players the same weeks.\n`,
  );

  /* ---------- the numbers ---------- */

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const maeAt = (
    rows: Played[], lineOf: (p: Played) => number, factor: number,
  ) => mean(rows.map((p) => Math.abs(p.actual - lineOf(p) * factor)));

  function bestFactor(rows: Played[], lineOf: (p: Played) => number): number {
    let best = 1;
    let bestMae = Infinity;

    for (let f = 0.3; f <= 1.2001; f += 0.01) {
      const at = maeAt(rows, lineOf, f);

      if (at < bestMae) {
        bestMae = at;
        best = f;
      }
    }

    return Number(best.toFixed(2));
  }

  function summarize(label: string, rows: Played[]) {
    console.log(`\n## ${label} (${rows.length})\n`);
    console.log("line        mean actual  mean line  ratio   mae");

    for (const [name, lineOf] of [
      ["ours", (p: Played) => p.ours],
      ["sleeper", (p: Played) => p.sleeper],
    ] as [string, (p: Played) => number][]) {
      const actual = mean(rows.map((p) => p.actual));
      const line = mean(rows.map(lineOf));

      console.log(
        name.padEnd(11) + actual.toFixed(2).padStart(12) +
          line.toFixed(2).padStart(11) + (actual / line).toFixed(3).padStart(8) +
          maeAt(rows, lineOf, 1).toFixed(3).padStart(7),
      );
    }
  }

  summarize("questionable, played", qPlayed);
  summarize("control, unlisted", control);

  /**
   * A discount that also helps the control group is not a questionable
   * finding, it is the ridge running high against a right-skewed score
   * distribution, so both groups are swept the same way to tell the two
   * apart.
   */
  function factorTable(label: string, rows: Played[]) {
    const fit = rows.filter((p) => fitSeasons.includes(p.season));
    const score = rows.filter((p) => scoreSeasons.includes(p.season));

    console.log(
      `\n## Factor swept on ${label}, fit ${fit.length}, scored ${score.length}\n`,
    );
    console.log("line        factor 1.0   0.86        fit factor   ceiling");

    for (const [name, lineOf] of [
      ["ours", (p: Played) => p.ours],
      ["sleeper", (p: Played) => p.sleeper],
    ] as [string, (p: Played) => number][]) {
      const fitted = bestFactor(fit, lineOf);
      const ceiling = bestFactor(score, lineOf);

      console.log(
        name.padEnd(11) +
          maeAt(score, lineOf, 1).toFixed(3).padStart(11) +
          maeAt(score, lineOf, FOUND_FACTOR).toFixed(3).padStart(12) +
          `${maeAt(score, lineOf, fitted).toFixed(3)} (${fitted})`.padStart(16) +
          `${maeAt(score, lineOf, ceiling).toFixed(3)} (${ceiling})`.padStart(16),
      );
    }
  }

  factorTable("questionable players", qPlayed);
  factorTable("the control group", control);

  /**
   * How much of 0.86's drop in MAE is specific to being questionable,
   * once the same drop measured on the control group is netted out. A
   * skewed score distribution rewards any across-the-board discount, so
   * the part that is actually about being questionable is the group's
   * drop minus the control group's own drop at the same factor.
   */
  console.log("\n## What 0.86 buys once the control group's own drop is netted out\n");
  console.log("line        questionable drop  control drop  net");

  for (const [name, lineOf] of [
    ["ours", (p: Played) => p.ours],
    ["sleeper", (p: Played) => p.sleeper],
  ] as [string, (p: Played) => number][]) {
    const qScore = qPlayed.filter((p) => scoreSeasons.includes(p.season));
    const cScore = control.filter((p) => scoreSeasons.includes(p.season));
    const qDrop = maeAt(qScore, lineOf, 1) - maeAt(qScore, lineOf, FOUND_FACTOR);
    const cDrop = maeAt(cScore, lineOf, 1) - maeAt(cScore, lineOf, FOUND_FACTOR);

    console.log(
      name.padEnd(11) + qDrop.toFixed(3).padStart(18) +
        cDrop.toFixed(3).padStart(14) + (qDrop - cDrop).toFixed(3).padStart(8),
    );
  }

  const PRACTICES = ["DNP", "Limited", "Full"];
  const MIN_CELL = 20;

  console.log("\n## Questionable, played, split by practice\n");
  console.log("practice   n     ours ratio  sleeper ratio");

  for (const practice of PRACTICES) {
    const group = qPlayed.filter((p) => p.practice === practice);

    if (group.length < MIN_CELL) {
      console.log(`${practice.padEnd(11)}${String(group.length).padStart(3)}  too few to split`);
      continue;
    }

    const actual = mean(group.map((p) => p.actual));
    const ours = mean(group.map((p) => p.ours));
    const sleep = mean(group.map((p) => p.sleeper));

    console.log(
      practice.padEnd(11) + String(group.length).padStart(3) +
        (actual / ours).toFixed(3).padStart(11) +
        (actual / sleep).toFixed(3).padStart(15),
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
