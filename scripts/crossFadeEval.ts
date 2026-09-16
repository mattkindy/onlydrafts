/**
 * The preseason weekly line, before and after the component-to-anchor
 * cross fade, scored week by week against what players actually did.
 *
 * Rebuilds the same preseason path buildSite.ts writes each August:
 * a world built only from what was known before kickoff, the ridge
 * model's week-by-week line, the component line from usage and rates,
 * and the season anchor. The rival is that same pipeline with the old
 * hard switch at week 4 put back; both are held to what nflverse says
 * a player actually scored, so nothing here trains on the week it
 * predicts.
 *
 * Run: npx tsx scripts/crossFadeEval.ts
 */

import { hasPlayerStats, loadGames, loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints } from "../src/scoring/fantasyPoints.js";
import { scoring } from "../src/scoring/active.js";
import { buildPreseasonWorld } from "../src/features/preseason.js";
import { projectDraftExamples } from "../src/features/seasonModel.js";
import {
  preseasonWeeklyInput,
  preseasonWeekly,
  anchorToSeason,
  type WeeklyProjection,
} from "../src/features/preseasonWeekly.js";
import {
  componentPoints,
  historiesForWeek,
  positionRatePriors,
  blendWithComponent,
  type History,
  type Rates,
} from "../src/features/componentWeek.js";
import { settingLift, sharedOut, type Setting } from "../src/features/weekSetting.js";
import { normalizeName } from "../src/data/names.js";
import { parseCsv } from "../src/data/csv.js";
import { kickoffsIn } from "../src/data/gameWeather.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const EVAL_SEASONS = Number(process.env["EVAL_ONE"] ?? 0)
  ? [Number(process.env["EVAL_ONE"])]
  : [2021, 2022, 2023, 2024, 2025];
/** the season the board is built for today, for the Travis Hunter chart */
const CURRENT_SEASON = 2026;
const LAST_WEEK = 8;
const PRIOR_SEASONS = 8;

/** how the site shipped this before the cross fade: a hard switch at week 4 */
const OLD_COMPONENT_THROUGH_WEEK = 4;

async function componentPriors(season: number): Promise<Map<string, Rates>> {
  const weeks = [];

  for (let s = season - PRIOR_SEASONS; s < season; s++) {
    weeks.push(...(await loadPlayerStats(s).catch(() => [])));
  }

  return positionRatePriors(weeks, scoring());
}

/** the pre-fade site: pure component through week 4, pure anchor after */
function oldWeekLine(
  week: number,
  anchored: number,
  history: History | undefined,
  prior: Rates | undefined,
): number {
  if (week > OLD_COMPONENT_THROUGH_WEEK || !history || !prior) {
    return anchored;
  }

  const points = componentPoints(history, prior, scoring());

  return points > 0 ? points : anchored;
}

/** the cross faded line this change ships */
function newWeekLine(
  week: number,
  anchored: number,
  history: History | undefined,
  prior: Rates | undefined,
): number {
  const points = history && prior
    ? componentPoints(history, prior, scoring())
    : undefined;

  return blendWithComponent(
    week, points !== undefined && points > 0 ? points : undefined, anchored,
  );
}

interface WeekLine {
  week: number;
  oldPoints: number;
  newPoints: number;
}

interface SeasonLines {
  lines: Map<string, WeekLine[]>;
  nameById: Map<string, string>;
}

async function weeksFor(season: number): Promise<SeasonLines> {
  const world = await buildPreseasonWorld(season);
  const draftExamples = await projectDraftExamples(season, world.data);
  const exampleById = new Map(draftExamples.map((e) => [e.playerId, e]));
  const priors = await componentPriors(season);

  // whatever of this season is on disk counts as trailing history, same
  // as the board build does; historiesForWeek only reads weeks before
  // the one asked about, so a week never sees its own stats.
  const thisSeason = hasPlayerStats(season)
    ? await loadPlayerStats(season)
    : [];
  const prevStats = await loadPlayerStats(season - 1).catch(() => []);
  const historiesByWeek = new Map<number, Map<string, History>>();

  // oldWeekLine below needs history through OLD_COMPONENT_THROUGH_WEEK
  // regardless of where the shipped fade is set today
  for (let w = 1; w <= OLD_COMPONENT_THROUGH_WEEK; w++) {
    historiesByWeek.set(
      w, historiesForWeek(thisSeason, prevStats, w, scoring()),
    );
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

  const out = new Map<string, WeekLine[]>();
  const nameById = new Map<string, string>();

  for (const p of world.players) {
    nameById.set(p.playerId, p.name);
    const said = saidWeekly.get(p.playerId);

    if (!said) {
      continue;
    }

    const lifts = sharedOut(said.map((w) =>
      settingLift(p.position, settingOf(p.teamId, w.week))));
    const lifted: WeeklyProjection[] = said.map((w, i) => ({
      ...w, points: w.points * lifts[i]!,
    }));
    const anchored = anchorToSeason(lifted, p.projectedPpg);
    const prior = priors.get(p.position);

    const lines: WeekLine[] = anchored
      .filter((w) => w.week <= LAST_WEEK)
      .map((w) => {
        const history = historiesByWeek.get(w.week)?.get(p.playerId);

        return {
          week: w.week,
          oldPoints: oldWeekLine(w.week, w.points, history, prior),
          newPoints: newWeekLine(w.week, w.points, history, prior),
        };
      });

    out.set(p.playerId, lines);
  }

  return { lines: out, nameById };
}

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

const errByWeek = new Map<number, { old: number[]; fresh: number[] }>();

for (const season of EVAL_SEASONS) {
  console.log(`working ${season}...`);
  await loadGames();
  const { lines } = await weeksFor(season);
  const truth = await truthFor(season);

  for (const [playerId, weeks] of lines) {
    const scored = truth.get(playerId);

    if (!scored) {
      continue;
    }

    for (const w of weeks) {
      const actual = scored.get(w.week);

      if (actual === undefined) {
        continue;
      }

      const at = errByWeek.get(w.week) ?? { old: [], fresh: [] };
      at.old.push(Math.abs(w.oldPoints - actual));
      at.fresh.push(Math.abs(w.newPoints - actual));
      errByWeek.set(w.week, at);
    }
  }
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

console.log("\nmean absolute error by week, today's build against this one:\n");
console.log("week   today    this build   n");

for (let week = 1; week <= LAST_WEEK; week++) {
  const at = errByWeek.get(week);

  if (!at) {
    continue;
  }

  console.log(
    `${String(week).padEnd(6)} ${mean(at.old).toFixed(2).padEnd(8)} ` +
      `${mean(at.fresh).toFixed(2).padEnd(12)} ${at.old.length}`,
  );
}

console.log(`\nworking ${CURRENT_SEASON} for the Travis Hunter chart...`);
await loadGames();
const { lines: currentLines, nameById: currentNames } =
  await weeksFor(CURRENT_SEASON);
const currentTruth = hasPlayerStats(CURRENT_SEASON)
  ? await truthFor(CURRENT_SEASON)
  : new Map<string, Map<number, number>>();

const travisId = [...currentNames].find(
  ([, name]) => normalizeName(name) === "travishunter",
)?.[0];
const travisWeeks = travisId ? currentLines.get(travisId) : undefined;

if (travisWeeks) {
  const scored = currentTruth.get(travisId!);
  console.log("\nTravis Hunter, week by week:\n");
  console.log("week   today    this build   actual");

  for (const w of travisWeeks) {
    const actual = scored?.get(w.week);
    console.log(
      `${String(w.week).padEnd(6)} ${w.oldPoints.toFixed(1).padEnd(8)} ` +
        `${w.newPoints.toFixed(1).padEnd(12)} ` +
        `${actual === undefined ? "-" : actual.toFixed(1)}`,
    );
  }
} else {
  console.log(`\ntravishunter not found on the ${CURRENT_SEASON} board`);
}
