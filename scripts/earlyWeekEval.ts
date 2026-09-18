/**
 * What belongs on the slate in weeks 2 to 4, when the weekly ridge is
 * reading one box score through coefficients learned on four game means.
 *
 * Five lines are scored against what players actually did: the ridge as
 * the slate builds it today, the moving season anchor the board keeps,
 * the ridge with its recent columns pulled toward each player's previous
 * season, the ridge retrained so it sees one game rows, and last
 * season's points a game as the rival. The ceiling is a ridge fitted on
 * the season it is scoring. Weeks 5 to 8 run as a control.
 * Everything fitted is fitted on seasons before the one being scored.
 *
 * Run: npx tsx scripts/earlyWeekEval.ts
 */

import { loadGames, loadPlayerStats } from "../src/data/nflverse.js";
import { scoring } from "../src/scoring/active.js";
import { fantasyPoints } from "../src/scoring/fantasyPoints.js";
import {
  weeklyExamplesForSeason,
  weeklyProspectiveForWeek,
  type WeeklySettings,
} from "../src/features/weeklyModel.js";
import {
  SHIPPED_WINDOWS,
  type WeeklyExample,
  type WeeklyWindows,
} from "../src/features/weekly.js";
import {
  buildRecentPriors,
  shrinkRecentMeans,
  type RecentPriors,
} from "../src/features/recentPrior.js";
import {
  fitWeeklyByPosition,
  POSITION_EXTRAS,
  predictWeeklyByPosition,
  type WeeklyByPosition,
} from "../src/features/fitWeeklyByPosition.js";
import { buildPreseasonWorld } from "../src/features/preseason.js";
import { projectDraftExamples } from "../src/features/seasonModel.js";
import {
  preseasonWeekly,
  preseasonWeeklyInput,
} from "../src/features/preseasonWeekly.js";
import { fitForSeason, readPlayedWeeks } from "../src/features/inSeasonBoard.js";
import { updateLevel } from "../src/features/inSeasonLevel.js";
import {
  settingLift,
  sharedOut,
  type Setting,
} from "../src/features/weekSetting.js";
import { parseCsv } from "../src/data/csv.js";
import { kickoffsIn } from "../src/data/gameWeather.js";
import {
  loadSleeperWeekly,
  projectionKey,
  sleeperPointsUnder,
} from "../src/data/sleeperProjections.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const EVAL_SEASONS = Number(process.env["EVAL_ONE"] ?? 0)
  ? [Number(process.env["EVAL_ONE"])]
  : [2021, 2022, 2023, 2024, 2025];
const EARLY_WEEKS = [2, 3, 4];
const CONTROL_WEEKS = [5, 6, 7, 8];
const WEEKS = [...EARLY_WEEKS, ...CONTROL_WEEKS];
const TRAIN_FROM = 2016;
const POSITIONS = new Set(["QB", "RB", "WR", "TE"]);

/** how many games of previous season the shrink is swept over */
const PRIOR_GRID = [1, 2, 3, 5, 8];

/** rows as the slate builds them today, with no shrink */
const RAW: WeeklySettings = { windows: SHIPPED_WINDOWS, priorGames: 0 };

/** rows from week 2 on with one game behind them, for the retrained fit */
const ONE_GAME_WINDOWS: WeeklyWindows = {
  trainWeeks: 1,
  slateWeeks: 1,
  firstWeek: 2,
};
const ONE_GAME: WeeklySettings = { windows: ONE_GAME_WINDOWS, priorGames: 0 };

/** the retrained fit gets to see how many games are behind a row */
const ONE_GAME_EXTRAS: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(POSITION_EXTRAS).map(([position, extras]) => [
    position,
    [...extras, "gamesBehind", "gamesBehindLast4"],
  ]),
);

const RIDGE = "A ridge as shipped";
const ANCHOR = "B season anchor";
const shrunkLabel = (k: number) => `C shrunk, k=${k}`;
const RETRAINED = "D retrained on one game rows";
const RIVAL = "rival prevPpg";
const CEILING = "ceiling in-sample ridge";

const LABELS = [
  RIDGE,
  ANCHOR,
  ...PRIOR_GRID.map(shrunkLabel),
  RETRAINED,
  RIVAL,
  CEILING,
];

interface Scored {
  predicted: number;
  actual: number;
}

/** every scored pair, by line, by week */
const scores = new Map<string, Map<number, Scored[]>>();

function record(label: string, week: number, pair: Scored): void {
  const byWeek = scores.get(label) ?? new Map<number, Scored[]>();
  const at = byWeek.get(week) ?? [];
  at.push(pair);
  byWeek.set(week, at);
  scores.set(label, byWeek);
}

const rawRowCache = new Map<string, WeeklyExample[]>();
const priorCache = new Map<number, RecentPriors>();

async function priorsFor(season: number): Promise<RecentPriors> {
  const held = priorCache.get(season);

  if (held) {
    return held;
  }

  const built = buildRecentPriors(
    await loadPlayerStats(season - 1).catch(() => []),
    scoring(),
  );
  priorCache.set(season, built);
  return built;
}

async function rawRowsFor(
  season: number,
  games: Awaited<ReturnType<typeof loadGames>>,
  settings: WeeklySettings,
  key: string,
): Promise<WeeklyExample[]> {
  const cacheKey = `${season}|${key}`;
  const held = rawRowCache.get(cacheKey);

  if (held) {
    return held;
  }

  const built = await weeklyExamplesForSeason(season, games, settings);
  rawRowCache.set(cacheKey, built);
  return built;
}

/** every training row before this season, shrunk by the same k as the slate */
async function trainingRows(
  season: number,
  games: Awaited<ReturnType<typeof loadGames>>,
  settings: WeeklySettings,
  key: string,
  priorGames: number,
): Promise<WeeklyExample[]> {
  const rows: WeeklyExample[] = [];

  for (let s = TRAIN_FROM; s < season; s++) {
    const priors = await priorsFor(s);
    rows.push(
      ...(await rawRowsFor(s, games, settings, key)).map((e) =>
        shrinkRecentMeans(e, priors, priorGames),
      ),
    );
  }

  return rows;
}

const mean = (xs: number[]) =>
  xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

const maeOf = (pairs: Scored[]) =>
  mean(pairs.map((p) => Math.abs(p.predicted - p.actual)));

function correlation(pairs: Scored[]): number {
  if (pairs.length < 2) {
    return 0;
  }

  const px = mean(pairs.map((p) => p.predicted));
  const py = mean(pairs.map((p) => p.actual));
  let top = 0;
  let leftSq = 0;
  let rightSq = 0;

  for (const pair of pairs) {
    const dx = pair.predicted - px;
    const dy = pair.actual - py;
    top += dx * dy;
    leftSq += dx * dx;
    rightSq += dy * dy;
  }

  if (leftSq <= 0 || rightSq <= 0) {
    return 0;
  }

  return top / Math.sqrt(leftSq * rightSq);
}

interface AnchorLines {
  lineFor(playerId: string, week: number): number | undefined;
}

/**
 * The season anchor's line for a player-week: his board level rebuilt
 * from only the games before that week, times what the preseason weekly
 * shape says this fixture is worth against his own average. The
 * opponent and the setting are both in that factor, which is what the
 * board's own week chart is built from, so the two come apart.
 */
async function anchorLinesFor(season: number): Promise<AnchorLines> {
  const world = await buildPreseasonWorld(season);
  const draftExamples = await projectDraftExamples(season, world.data);
  const exampleById = new Map(draftExamples.map((e) => [e.playerId, e]));
  const said = preseasonWeekly(await preseasonWeeklyInput(world, exampleById));

  const gameRows = parseCsv(
    await readFile(
      join(import.meta.dirname, "..", "data", "raw", "games.csv"),
      "utf8",
    ),
  );
  const whereEach = new Map<string, Setting>();

  for (const k of kickoffsIn(gameRows, season)) {
    for (const [team, rest] of [
      [k.homeTeam, k.homeRest],
      [k.awayTeam, k.awayRest],
    ] as [string, number][]) {
      whereEach.set(`${team}|${k.week}`, {
        indoors: k.indoors,
        night: k.hour >= 18,
        restDays: rest,
      });
    }
  }

  const settingOf = (team: string, week: number): Setting =>
    whereEach.get(`${team}|${week}`) ??
    { indoors: false, night: false, restDays: 7 };

  const fit = await fitForSeason(season);
  const read = await readPlayedWeeks(season);
  const lines = new Map<string, number>();

  for (const p of world.players) {
    const his = said.get(p.playerId);

    if (!his) {
      continue;
    }

    const lifts = sharedOut(
      his.map((w) => settingLift(p.position, settingOf(p.teamId, w.week))),
    );
    const lifted = his.map((w, i) => ({ ...w, points: w.points * lifts[i]! }));
    const meanLifted = mean(lifted.map((w) => w.points));
    const weeksPlayed = read.weeks.get(p.playerId) ?? [];

    for (const wk of lifted) {
      if (!WEEKS.includes(wk.week)) {
        continue;
      }

      const level = updateLevel(fit, {
        anchor: p.projectedPpg,
        position: p.position,
        weeks: weeksPlayed.filter((x) => x.week < wk.week),
      }).ppg;

      lines.set(
        `${p.playerId}|${wk.week}`,
        meanLifted <= 0 ? level : (wk.points / meanLifted) * level,
      );
    }
  }

  return { lineFor: (playerId, week) => lines.get(`${playerId}|${week}`) };
}

const games = await loadGames();

for (const season of EVAL_SEASONS) {
  console.log(`working ${season}...`);

  const models = new Map<string, WeeklyByPosition>();
  models.set(
    RIDGE,
    fitWeeklyByPosition(await trainingRows(season, games, RAW, "shipped", 0)),
  );

  for (const k of PRIOR_GRID) {
    models.set(
      shrunkLabel(k),
      fitWeeklyByPosition(await trainingRows(season, games, RAW, "shipped", k)),
    );
  }

  models.set(
    RETRAINED,
    fitWeeklyByPosition(
      await trainingRows(season, games, ONE_GAME, "oneGame", 0),
      ONE_GAME_EXTRAS,
    ),
  );
  // the ceiling reads the season it is scoring, which nothing shipped can
  models.set(
    CEILING,
    fitWeeklyByPosition(await rawRowsFor(season, games, RAW, "shipped")),
  );

  const priors = await priorsFor(season);
  const anchors = await anchorLinesFor(season);
  const truth = new Map<string, number>();

  for (const row of await loadPlayerStats(season)) {
    truth.set(
      `${row.playerId}|${row.week}`,
      fantasyPoints(row.statLine, scoring()),
    );
  }

  for (const week of WEEKS) {
    const slate = await weeklyProspectiveForWeek(season, week, games, RAW);

    for (const raw of slate) {
      if (!POSITIONS.has(raw.position)) {
        continue;
      }

      const actual = truth.get(`${raw.playerId}|${week}`);
      const anchored = anchors.lineFor(raw.playerId, week);

      // only a player every candidate has a line for, so the table
      // compares like with like
      if (actual === undefined || anchored === undefined) {
        continue;
      }

      record(ANCHOR, week, { predicted: anchored, actual });
      record(RIVAL, week, {
        predicted:
          raw.prevPpg > 0
            ? raw.prevPpg
            : priors.byPosition.get(raw.position)?.points ?? 0,
        actual,
      });

      for (const label of [RIDGE, RETRAINED, CEILING]) {
        record(label, week, {
          predicted: predictWeeklyByPosition(models.get(label)!, raw),
          actual,
        });
      }

      for (const k of PRIOR_GRID) {
        record(shrunkLabel(k), week, {
          predicted: predictWeeklyByPosition(
            models.get(shrunkLabel(k))!,
            shrinkRecentMeans(raw, priors, k),
          ),
          actual,
        });
      }
    }
  }
}

function pooled(label: string, weeks: number[]): Scored[] {
  const byWeek = scores.get(label) ?? new Map<number, Scored[]>();
  return weeks.flatMap((week) => byWeek.get(week) ?? []);
}

function tableOf(
  of: (pairs: Scored[]) => number,
  digits: number,
): void {
  const header = ["line".padEnd(28)]
    .concat(WEEKS.map((w) => `wk${w}`.padEnd(6)))
    .concat(["wk2-4".padEnd(7), "wk5-8"]);
  console.log(header.join(" "));

  for (const label of LABELS) {
    const byWeek = scores.get(label) ?? new Map<number, Scored[]>();
    const cells = WEEKS.map((week) =>
      of(byWeek.get(week) ?? []).toFixed(digits).padEnd(6),
    );
    console.log(
      [
        label.padEnd(28),
        ...cells,
        of(pooled(label, EARLY_WEEKS)).toFixed(3).padEnd(7),
        of(pooled(label, CONTROL_WEEKS)).toFixed(3),
      ].join(" "),
    );
  }
}

console.log(`\nrows scored, pooled over ${EVAL_SEASONS.join(", ")}:\n`);

for (const week of WEEKS) {
  console.log(`week ${week}: ${(scores.get(RIDGE)?.get(week) ?? []).length}`);
}

console.log("\nmean absolute error by week:\n");
tableOf(maeOf, 2);
console.log("\ncorrelation with the actual score, by week:\n");
tableOf(correlation, 3);

/**
 * How far each line beats the shipped ridge on the same player-weeks,
 * with the standard error of that difference, so a gap of six hundredths
 * of a point can be told from nothing. Every line records a pair in the
 * same order, so the two lists line up row for row.
 */
function pairedAgainstRidge(label: string, weeks: number[]): string {
  const mine = pooled(label, weeks);
  const theirs = pooled(RIDGE, weeks);
  const gaps = mine.map(
    (pair, i) =>
      Math.abs(theirs[i]!.predicted - theirs[i]!.actual) -
      Math.abs(pair.predicted - pair.actual),
  );
  const middle = mean(gaps);
  const spread = Math.sqrt(
    mean(gaps.map((g) => (g - middle) * (g - middle))) / gaps.length,
  );

  return `${middle >= 0 ? "+" : ""}${middle.toFixed(3)} ` +
    `(se ${spread.toFixed(3)})`;
}

console.log("\nerror saved against the shipped ridge, same rows:\n");
console.log(["line".padEnd(28), "weeks 2-4".padEnd(20), "weeks 5-8"].join(" "));

for (const label of LABELS) {
  console.log(
    [
      label.padEnd(28),
      pairedAgainstRidge(label, EARLY_WEEKS).padEnd(20),
      pairedAgainstRidge(label, CONTROL_WEEKS),
    ].join(" "),
  );
}

/**
 * Sleeper against the same actual scores on 2026 week 2, which is the
 * one week where a projection file and a played week overlap. It is the
 * number a reader would compare ours against.
 */
const SANITY_SEASON = 2026;
const SANITY_WEEK = 2;
const projections = await loadSleeperWeekly();
const sanityStats = await loadPlayerStats(SANITY_SEASON).catch(() => []);
const played = sanityStats.filter((r) => r.week === SANITY_WEEK);

if (played.length === 0) {
  console.log(`\nno played ${SANITY_SEASON} week ${SANITY_WEEK} to score`);
} else {
  const sleeperPairs: Scored[] = [];

  for (const row of played) {
    const said = projections.get(
      projectionKey(SANITY_SEASON, SANITY_WEEK, row.playerId),
    );

    if (!said || !POSITIONS.has(row.position)) {
      continue;
    }

    sleeperPairs.push({
      predicted: sleeperPointsUnder(said, scoring().receptions),
      actual: fantasyPoints(row.statLine, scoring()),
    });
  }

  console.log(
    `\nSleeper on ${SANITY_SEASON} week ${SANITY_WEEK}: ` +
      `${sleeperPairs.length} players, mae ${maeOf(sleeperPairs).toFixed(2)}, ` +
      `correlation ${correlation(sleeperPairs).toFixed(3)}`,
  );
}
