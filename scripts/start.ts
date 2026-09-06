// Who do I start: our projection, Sleeper's, and the average of the two,
// with a floor and a ceiling for a coming week.
// Run: npx tsx scripts/start.ts --season 2025 --week 10 "st. brown" "nacua"

import {
  comingWeek,
  hasPlayerStats,
  latestSeason,
  loadGames,
  type GameRow,
} from "../src/data/nflverse.js";
import { buildPreseasonWorld } from "../src/features/preseason.js";
import { projectDraftExamples } from "../src/features/seasonModel.js";
import {
  preseasonWeeklyExamples,
  preseasonWeeklyInput,
} from "../src/features/preseasonWeekly.js";
import { normalizeName } from "../src/data/names.js";
import {
  loadSleeperWeekly,
  projectionKey,
} from "../src/data/sleeperProjections.js";
import {
  weeklyExamplesForSeason,
  weeklyProspectiveForWeek,
} from "../src/features/weeklyModel.js";
import type { WeeklyExample } from "../src/features/weekly.js";
import {
  fitWeeklyByPosition,
  predictWeeklyByPosition,
} from "../src/features/fitWeeklyByPosition.js";
import {
  blendPoints,
  SHIPPED_BLEND_WEIGHT,
  WIDE_SPLIT_POINTS,
  WIDE_SPLIT_SLEEPER_RATE,
} from "../src/features/sleeperBlend.js";
import {
  buildResidualModel,
  outcomeQuantile,
} from "../src/backtest/intervals.js";

function argOf(flag: string): number | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : Number(process.argv[index + 1]);
}

interface Row {
  example: WeeklyExample;
  ours: number;
  sleeper: number | undefined;
  ranked: number;
  floor: number;
  ceiling: number;
}

function pointsOrBlank(points: number | undefined): string {
  return points === undefined ? "     " : points.toFixed(1).padStart(5);
}

/** two projections this close apart have picked the winner at chance */
const COIN_FLIP_POINTS = 2;

function verdict(first: Row, second: Row): string {
  const gap = first.ranked - second.ranked;
  const lead = `${first.example.playerName} is ${gap.toFixed(1)} points ahead of ${second.example.playerName} on the average of the two projections.`;

  if (gap < COIN_FLIP_POINTS) {
    return `${lead} That is inside the two points where every method we have measured picks the winner at chance, so either one is defensible.`;
  }

  return `Start ${first.example.playerName}. ${lead}`;
}

const SLATE_POSITIONS = ["QB", "RB", "WR", "TE"];

/**
 * Everyone's row for a coming week. Before the season's first game
 * nflverse has published no weekly stats, so there is no recent form to
 * read and the rows come from last season's per-game rates over this
 * season's schedule, which is the path the board's own weeks take.
 */
async function slateFor(
  season: number,
  week: number,
  games: GameRow[],
): Promise<WeeklyExample[]> {
  if (hasPlayerStats(season)) {
    return weeklyProspectiveForWeek(season, week, games);
  }

  console.error(
    `No weekly stats for ${season} yet, so week ${week} is projected from ` +
      "last season's rates. Building that takes a minute.",
  );
  const world = await buildPreseasonWorld(season);
  const examples = await projectDraftExamples(season, world.data);
  const input = await preseasonWeeklyInput(
    world,
    new Map(examples.map((e) => [e.playerId, e])),
  );

  return [...preseasonWeeklyExamples(input).values()].flatMap((his) =>
    his.filter(
      (e) => e.week === week && SLATE_POSITIONS.includes(e.position),
    ));
}

async function main(): Promise<void> {
  const games = await loadGames();
  const season = argOf("--season") ?? latestSeason(games);
  const week = argOf("--week") ?? comingWeek(games, season);

  const names = process.argv
    .slice(2)
    .filter(
      (a, i, all) =>
        !a.startsWith("--") &&
        all[i - 1] !== "--season" &&
        all[i - 1] !== "--week",
    )
    .map(normalizeName);

  const train: WeeklyExample[] = [];

  for (let s = 2016; s < season; s++) {
    train.push(...(await weeklyExamplesForSeason(s, games)));
  }

  const model = fitWeeklyByPosition(train);
  const residuals = buildResidualModel(
    train.map((e) => ({
      position: e.position,
      predicted: predictWeeklyByPosition(model, e),
      actual: e.target,
    })),
    5,
  );

  const projections = await loadSleeperWeekly();
  const slate = await slateFor(season, week, games);
  const requested =
    names.length > 0
      ? slate.filter((e) =>
          names.some((n) => normalizeName(e.playerName).includes(n)),
        )
      : slate;

  const rows: Row[] = requested
    .map((e) => {
      const ours = predictWeeklyByPosition(model, e);
      const sleeper = projections.get(
        projectionKey(season, week, e.playerId),
      )?.points;
      const ranked =
        sleeper === undefined
          ? ours
          : blendPoints(ours, sleeper, SHIPPED_BLEND_WEIGHT);

      return {
        example: e,
        ours,
        sleeper,
        ranked,
        floor: outcomeQuantile(residuals, e.position, ranked, 0.1),
        ceiling: outcomeQuantile(residuals, e.position, ranked, 0.9),
      };
    })
    .sort((a, b) => b.ranked - a.ranked);

  const shown = names.length > 0 ? rows : rows.slice(0, 25);
  const missing = shown.filter((r) => r.sleeper === undefined);

  const from = hasPlayerStats(season)
    ? ""
    : ", projected from last season's rates";
  console.log(`${season} week ${week}${from}`);
  console.log(
    "player                      pos  ours sleep   avg  floor  ceil  vs    implied recent-ppg snaps",
  );

  for (const row of shown) {
    const e = row.example;
    const venue = e.home ? "v" : "@";
    console.log(
      `${e.playerName.padEnd(27)} ${e.position.padEnd(3)} ${row.ours.toFixed(1).padStart(5)} ${pointsOrBlank(row.sleeper)} ${row.ranked.toFixed(1).padStart(5)} ${row.floor.toFixed(1).padStart(6)} ${row.ceiling.toFixed(1).padStart(5)}  ${venue}${e.opponent.padEnd(4)} ${e.impliedTotal.toFixed(1).padStart(6)} ${e.last4.toFixed(1).padStart(9)} ${(e.snapRecent * 100).toFixed(0).padStart(4)}%`,
    );
  }

  if (missing.length > 0) {
    const who = missing.map((r) => r.example.playerName).join(", ");
    console.log(
      `\nSleeper has no projection for ${who}, so ${missing.length === 1 ? "he is" : "they are"} ranked on our number alone.`,
    );
  }

  const split = shown.filter(
    (r) =>
      r.sleeper !== undefined &&
      Math.abs(r.ours - r.sleeper) >= WIDE_SPLIT_POINTS,
  );

  if (split.length > 0) {
    console.log("");
  }

  const rate = Math.round(WIDE_SPLIT_SLEEPER_RATE * 100);

  for (const row of split.slice(0, 5)) {
    const gap = row.ours - row.sleeper!;
    const side = gap > 0 ? "higher" : "lower";
    console.log(
      `We are ${Math.abs(gap).toFixed(1)} points ${side} on ${row.example.playerName} than Sleeper. Sleeper has the better of a split that wide about ${rate}% of the time.`,
    );
  }

  if (split.length > 5) {
    console.log(
      `${split.length - 5} more men split by three points or more, Sleeper the higher of the two on ${split.slice(5).filter((r) => r.sleeper! > r.ours).length} of them.`,
    );
  }

  if (names.length > 1 && shown.length > 1) {
    console.log(`\n${verdict(shown[0]!, shown[1]!)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
