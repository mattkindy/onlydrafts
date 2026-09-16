/**
 * Re-measures the component-to-anchor cross fade now that the anchor
 * moves during the season (buildSite.ts calls updateBoardLevels right
 * before the fade runs), instead of sitting on the August number.
 *
 * Each week's anchor is rebuilt from only the games before that week,
 * the same restriction historiesForWeek puts on the component side.
 * Sweeps where the ramp starts falling and where it reaches zero, and
 * reports mean absolute error by week against today's ramp, the
 * anchor alone with no component, the sweep's best setting, and an
 * oracle holding the actual score.
 *
 * Run: npx tsx scripts/crossFadeAnchorEval.ts
 */

import { hasPlayerStats, loadGames, loadPlayerStats } from "../src/data/nflverse.js";
import { scoring } from "../src/scoring/active.js";
import { buildPreseasonWorld } from "../src/features/preseason.js";
import { projectDraftExamples } from "../src/features/seasonModel.js";
import {
  preseasonWeeklyInput,
  preseasonWeekly,
} from "../src/features/preseasonWeekly.js";
import {
  componentPoints,
  historiesForWeek,
  positionRatePriors,
  type History,
  type Rates,
} from "../src/features/componentWeek.js";
import { fitForSeason, readPlayedWeeks } from "../src/features/inSeasonBoard.js";
import { updateLevel } from "../src/features/inSeasonLevel.js";
import { settingLift, sharedOut, type Setting } from "../src/features/weekSetting.js";
import { parseCsv } from "../src/data/csv.js";
import { kickoffsIn } from "../src/data/gameWeather.js";
import { fantasyPoints } from "../src/scoring/fantasyPoints.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const EVAL_SEASONS = Number(process.env["EVAL_ONE"] ?? 0)
  ? [Number(process.env["EVAL_ONE"])]
  : [2021, 2022, 2023, 2024, 2025];
const LAST_WEEK = 8;
const PRIOR_SEASONS = 8;

/** where a ramp is allowed to start falling, in the sweep */
const FADE_FROM_GRID = [1, 2, 3, 4];
/** where a ramp is allowed to reach zero, in the sweep */
const FADE_TO_GRID = [2, 3, 4, 5, 6, 7, 8];

/** today's shipped setting, so it always shows up as a named rival */
const TODAY_FROM = 2;
const TODAY_TO = 6;

/** what nflverse says each player actually scored, week by week */
async function truthFor(season: number): Promise<Map<string, Map<number, number>>> {
  const stats = await loadPlayerStats(season);
  const out = new Map<string, Map<number, number>>();

  for (const s of stats) {
    if (s.week > LAST_WEEK) {
      continue;
    }

    const byWeek = out.get(s.playerId) ?? new Map<number, number>();
    byWeek.set(s.week, fantasyPoints(s.statLine, scoring()));
    out.set(s.playerId, byWeek);
  }

  return out;
}

async function componentPriors(season: number): Promise<Map<string, Rates>> {
  const weeks = [];

  for (let s = season - PRIOR_SEASONS; s < season; s++) {
    weeks.push(...(await loadPlayerStats(s).catch(() => [])));
  }

  return positionRatePriors(weeks, scoring());
}

/**
 * The component's weight at a week, for an arbitrary start and end of
 * the ramp rather than the shipped constants. `to <= from` reads as
 * the ramp never running, which is how the sweep expresses the
 * anchor-only rival without a separate code path.
 */
function rampWeight(week: number, from: number, to: number): number {
  if (to <= from) {
    return 0;
  }

  if (week <= from) {
    return 1;
  }

  if (week >= to) {
    return 0;
  }

  return (to - week) / (to - from);
}

interface RampSetting {
  label: string;
  from: number;
  to: number;
}

const grid: RampSetting[] = [];

for (const from of FADE_FROM_GRID) {
  for (const to of FADE_TO_GRID) {
    if (to > from) {
      grid.push({ label: `${from}-${to}`, from, to });
    }
  }
}

const ANCHOR_ONLY = "anchor only, no component";
const ORACLE = "oracle (actual score)";

/** mean absolute error, by ramp setting, by week */
const errors = new Map<string, Map<number, number[]>>();

function record(label: string, week: number, err: number): void {
  const byWeek = errors.get(label) ?? new Map<number, number[]>();
  const at = byWeek.get(week) ?? [];
  at.push(err);
  byWeek.set(week, at);
  errors.set(label, byWeek);
}

for (const season of EVAL_SEASONS) {
  console.log(`working ${season}...`);
  await loadGames();

  const world = await buildPreseasonWorld(season);
  const draftExamples = await projectDraftExamples(season, world.data);
  const exampleById = new Map(draftExamples.map((e) => [e.playerId, e]));
  const priors = await componentPriors(season);

  const thisSeason = hasPlayerStats(season) ? await loadPlayerStats(season) : [];
  const prevStats = await loadPlayerStats(season - 1).catch(() => []);
  const historiesByWeek = new Map<number, Map<string, History>>();

  for (let w = 1; w < LAST_WEEK; w++) {
    historiesByWeek.set(w, historiesForWeek(thisSeason, prevStats, w, scoring()));
  }

  const saidInput = await preseasonWeeklyInput(world, exampleById);
  const saidWeekly = preseasonWeekly(saidInput);

  const gameRows = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "raw", "games.csv"), "utf8"));
  const whereEach = new Map<string, Setting>();

  for (const k of kickoffsIn(gameRows, season)) {
    for (const [team, rest] of [
      [k.homeTeam, k.homeRest], [k.awayTeam, k.awayRest],
    ] as [string, number][]) {
      whereEach.set(`${team}|${k.week}`, {
        indoors: k.indoors, night: k.hour >= 18, restDays: rest,
      });
    }
  }

  const settingOf = (team: string, week: number): Setting =>
    whereEach.get(`${team}|${week}`) ??
      { indoors: false, night: false, restDays: 7 };

  // a role fit off the eight seasons before this one, so each week's
  // anchor below is rebuilt from only the games that came before it
  const fit = await fitForSeason(season);
  const read = await readPlayedWeeks(season);
  const truth = await truthFor(season);

  for (const p of world.players) {
    const said = saidWeekly.get(p.playerId);

    if (!said) {
      continue;
    }

    const scored = truth.get(p.playerId);

    if (!scored) {
      continue;
    }

    const lifts = sharedOut(said.map((w) =>
      settingLift(p.position, settingOf(p.teamId, w.week))));
    const lifted = said.map((w, i) => ({ ...w, points: w.points * lifts[i]! }));
    const meanLifted = lifted.reduce((s, w) => s + w.points, 0) /
      (lifted.length || 1);
    const weeksPlayed = read.weeks.get(p.playerId) ?? [];

    for (const wk of lifted) {
      if (wk.week > LAST_WEEK) {
        continue;
      }

      const actual = scored.get(wk.week);

      if (actual === undefined) {
        continue;
      }

      const weeksBefore = weeksPlayed.filter((x) => x.week < wk.week);
      const anchorUpdated = updateLevel(fit, {
        anchor: p.projectedPpg, position: p.position, weeks: weeksBefore,
      }).ppg;
      const anchoredPoints = meanLifted <= 0
        ? anchorUpdated
        : (wk.points / meanLifted) * anchorUpdated;

      const history = historiesByWeek.get(wk.week)?.get(p.playerId);
      const prior = priors.get(p.position);
      const rawComponent = history && prior
        ? componentPoints(history, prior, scoring())
        : undefined;
      const component = rawComponent !== undefined && rawComponent > 0
        ? rawComponent
        : undefined;

      for (const setting of grid) {
        const weight = rampWeight(wk.week, setting.from, setting.to);
        const predicted = weight <= 0 || component === undefined
          ? anchoredPoints
          : weight * component + (1 - weight) * anchoredPoints;

        record(setting.label, wk.week, Math.abs(predicted - actual));
      }

      record(ANCHOR_ONLY, wk.week, Math.abs(anchoredPoints - actual));
      record(ORACLE, wk.week, 0);
    }
  }
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

function pooledMean(byWeek: Map<number, number[]>): number {
  const all = [...byWeek.values()].flat();
  return mean(all);
}

let bestLabel = `${TODAY_FROM}-${TODAY_TO}`;
let bestScore = Infinity;

for (const setting of grid) {
  const byWeek = errors.get(setting.label);

  if (!byWeek) {
    continue;
  }

  const score = pooledMean(byWeek);

  if (score < bestScore - 1e-9) {
    bestScore = score;
    bestLabel = setting.label;
  }
}

console.log("\ncounts, weeks 1 through 8, pooled over all seasons:\n");
const countsRow = errors.get(ANCHOR_ONLY)!;
console.log("week   n");

for (let week = 1; week <= LAST_WEEK; week++) {
  console.log(`${String(week).padEnd(6)} ${(countsRow.get(week) ?? []).length}`);
}

console.log("\nfull sweep, mean absolute error by week, pooled over "
  + `${EVAL_SEASONS.join(", ")}:\n`);
const header = ["setting".padEnd(10)]
  .concat([1, 2, 3, 4, 5, 6, 7, 8].map((w) => `wk${w}`.padEnd(6)))
  .concat(["overall"]);
console.log(header.join(" "));

for (const setting of grid) {
  const byWeek = errors.get(setting.label);

  if (!byWeek) {
    continue;
  }

  const cells = [1, 2, 3, 4, 5, 6, 7, 8].map((w) =>
    mean(byWeek.get(w) ?? []).toFixed(2).padEnd(6));
  console.log(
    [setting.label.padEnd(10), ...cells, pooledMean(byWeek).toFixed(3)].join(" "),
  );
}

console.log("\nnamed rivals:\n");

const rivals: { label: string; key: string }[] = [
  { label: `today's ramp (${TODAY_FROM}-${TODAY_TO})`, key: `${TODAY_FROM}-${TODAY_TO}` },
  { label: ANCHOR_ONLY, key: ANCHOR_ONLY },
  { label: `best from the sweep (${bestLabel})`, key: bestLabel },
  { label: ORACLE, key: ORACLE },
];

console.log(header.join(" "));

for (const rival of rivals) {
  const byWeek = errors.get(rival.key);

  if (!byWeek) {
    continue;
  }

  const cells = [1, 2, 3, 4, 5, 6, 7, 8].map((w) =>
    mean(byWeek.get(w) ?? []).toFixed(2).padEnd(6));
  console.log(
    [rival.label.padEnd(10), ...cells, pooledMean(byWeek).toFixed(3)].join(" "),
  );
}
