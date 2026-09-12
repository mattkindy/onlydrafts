/**
 * Every man's week as the site would have priced it before kickoff: the
 * component line blended with Sleeper, and the five figures the residual
 * model gives it.
 *
 * The fit behind this takes eight seasons and several minutes, and the
 * live remainder eval wants the same numbers in every share, so it is
 * done once here and written out.
 *
 * Run: npx tsx scripts/aggregateLiveLines.ts [seasons]
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadGames, RAW_DIR } from "../src/data/nflverse.js";
import { weeklyExamplesForSeason } from "../src/features/weeklyModel.js";
import {
  fitWeeklyByPosition, predictWeeklyByPosition,
} from "../src/features/fitWeeklyByPosition.js";
import {
  buildResidualModel, outcomeQuantile,
} from "../src/backtest/intervals.js";
import {
  loadSleeperWeekly, projectionKey,
} from "../src/data/sleeperProjections.js";
import {
  blendPoints, SHIPPED_BLEND_WEIGHT,
} from "../src/features/sleeperBlend.js";
import { LINE_COLUMNS } from "../src/backtest/liveLines.js";

const SEASONS = (process.argv[2] ?? "2024,2025").split(",").map(Number);
const TRAIN = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023];
const SEATED = ["QB", "RB", "WR", "TE"];
/** a man under this is nobody's starter, so lineups are drawn above it */
const LOW_BAR = 5;

const games = await loadGames();
const train = [];

for (const season of TRAIN) {
  train.push(...(await weeklyExamplesForSeason(season, games)));
}

const weekly = fitWeeklyByPosition(train);
const residuals = buildResidualModel(
  train.map((e) => ({
    position: e.position,
    predicted: predictWeeklyByPosition(weekly, e),
    actual: e.target,
  })),
  5,
);
const projections = await loadSleeperWeekly();
console.log(`fitted on ${train.length} examples`);

for (const season of SEASONS) {
  const rows = [LINE_COLUMNS.join(",")];

  for (const e of await weeklyExamplesForSeason(season, games)) {
    if (!e.teamId || !e.opponent || !SEATED.includes(e.position)) {
      continue;
    }

    const ours = predictWeeklyByPosition(weekly, e);
    const sleeper = projections.get(
      projectionKey(season, e.week, e.playerId))?.points;
    const blend = sleeper === undefined
      ? ours
      : blendPoints(ours, sleeper, SHIPPED_BLEND_WEIGHT);

    if (blend < LOW_BAR) {
      continue;
    }

    const quantile = (p: number) =>
      outcomeQuantile(residuals, e.position, blend, p);
    const floor = quantile(0.1);
    const ceiling = quantile(0.9);
    const round = (n: number) => Math.round(n * 1000) / 1000;

    rows.push([
      season, e.week, e.playerId, e.position, e.teamId.toUpperCase(),
      e.opponent.toUpperCase(), round(ours), sleeper ?? "", round(blend),
      round(floor), round((floor + blend) / 2), round((blend + ceiling) / 2),
      round(ceiling),
    ].join(","));
  }

  const out = join(RAW_DIR, "..", "curated", `liveLines-${season}.csv`);
  await writeFile(out, rows.join("\n") + "\n");
  console.log(`${season}: ${rows.length - 1} men`);
}
