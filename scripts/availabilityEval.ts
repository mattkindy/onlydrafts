/**
 * Can we say who stays on the field better than four buckets can?
 *
 * The board decides availability from last season's games put in one
 * of four bins. This builds a row per player-season out of his three
 * previous seasons, his age and size, how much he was given, how much
 * of last season he spent on the injury report, whether he was still
 * on it at the end, and how much of his home schedule is on turf, then
 * scores both against what actually happened.
 *
 * Run: npx tsx scripts/availabilityEval.ts
 */

import { spearman } from "../src/backtest/metrics.js";
import { readAvailability } from "../src/features/availabilityData.js";
import {
  fitAvailability, predictAvailability,
} from "../src/features/gamesPlayed.js";

const SEASONS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
const TEST = [2022, 2023, 2024, 2025];
async function main(): Promise<void> {
  const { rowsFor } = await readAvailability(SEASONS);

  /** what the board does today: four bins on last season's games */
  const bucketOf = (games: number) =>
    games >= 15 ? "durable" : games >= 10 ? "spotty" : "thin";

  console.log("expected games played, against what happened");
  console.log("season   men   buckets: off by  order    model: off by  order");
  const summed = { bucketMae: 0, modelMae: 0, bucketRank: 0, modelRank: 0, n: 0 };

  interface Scored {
    position: string;
    age?: number;
    gamesPrev: number;
    played: number;
    saidBucket: number;
    saidModel: number;
  }
  const pooled: Scored[] = [];

  for (const season of TEST) {
    const train = SEASONS.filter((s) => s < season).flatMap(rowsFor);
    const test = rowsFor(season);

    if (!train.length || !test.length) {
      continue;
    }

    const weights = fitAvailability(train);
    const pools = new Map<string, number[]>();

    for (const r of train) {
      const key = bucketOf(r.gamesPrev);
      pools.set(key, [...(pools.get(key) ?? []), r.played!]);
    }

    const poolMean = new Map(
      [...pools].map(([key, all]) =>
        [key, all.reduce((a, b) => a + b, 0) / all.length]),
    );
    const truth = test.map((r) => r.played!);
    const saidBucket = test.map((r) => poolMean.get(bucketOf(r.gamesPrev)) ?? 14);
    const saidModel = test.map((r) => predictAvailability(weights, r));
    const mae = (said: number[]) =>
      said.reduce((sum, v, i) => sum + Math.abs(v - truth[i]!), 0) / said.length;

    console.log(
      `${season}  ${String(test.length).padStart(4)}      ` +
        `${mae(saidBucket).toFixed(2)}  ${spearman(saidBucket, truth).toFixed(3)}` +
        `          ${mae(saidModel).toFixed(2)}  ${spearman(saidModel, truth).toFixed(3)}`,
    );
    summed.bucketMae += mae(saidBucket);
    summed.modelMae += mae(saidModel);
    summed.bucketRank += spearman(saidBucket, truth);
    summed.modelRank += spearman(saidModel, truth);
    summed.n++;

    test.forEach((r, i) => {
      pooled.push({
        position: r.position, age: r.age, gamesPrev: r.gamesPrev,
        played: truth[i]!, saidBucket: saidBucket[i]!, saidModel: saidModel[i]!,
      });
    });
  }

  const n = Math.max(1, summed.n);
  console.log(
    `mean              ${(summed.bucketMae / n).toFixed(2)}  ` +
      `${(summed.bucketRank / n).toFixed(3)}          ` +
      `${(summed.modelMae / n).toFixed(2)}  ${(summed.modelRank / n).toFixed(3)}`,
  );

  // and what each signal is worth, from the last fit
  const train = SEASONS.filter((s) => s < 2025).flatMap(rowsFor);
  const weights = fitAvailability(train);
  const names = [
    "level", "games last year", "two years ago", "three years ago",
    "no second season", "age over 26", "age over 29",
    "is a back", "is a quarterback", "is a tight end",
    "touches a game", "touches a game, backs", "touches a game, passers",
    "weight", "weeks out", "weeks listed", "ended the year hurt", "plays on turf",
    "weeks on reserve", "opened the year on reserve",
  ];
  console.log("\nwhat each signal moves a season by, in games:");
  names.forEach((name, i) => {
    const moves = (weights[i] ?? 0) * 17;

    if (i > 0 && Math.abs(moves) >= 0.15) {
      console.log(`  ${name.padEnd(24)} ${moves > 0 ? "+" : ""}${moves.toFixed(2)}`);
    }
  });

  /** average error can hide a bias that only shows up inside a group */
  const ageBandOf = (age: number) =>
    age <= 25 ? "25 and under" : age <= 28 ? "26 to 28" : age <= 30 ? "29 to 30" : "31 and over";
  const gamesBandOf = (games: number) =>
    games <= 8 ? "0 to 8" : games <= 14 ? "9 to 14" : "15 to 17";

  const printGroup = (label: string, its: Scored[]) => {
    const meanOf = (vs: number[]) => vs.reduce((a, b) => a + b, 0) / vs.length;
    const played = meanOf(its.map((r) => r.played));
    const bucket = meanOf(its.map((r) => r.saidBucket));
    const model = meanOf(its.map((r) => r.saidModel));

    console.log(
      `${label.padEnd(20)} ${String(its.length).padStart(4)}   ` +
      `${model.toFixed(2).padStart(7)}   ${played.toFixed(2).padStart(6)}   ` +
      `${(model - played).toFixed(2).padStart(6)}      ` +
      `${bucket.toFixed(2).padStart(7)}   ${(bucket - played).toFixed(2).padStart(6)}`,
    );
  };

  console.log(
    "\ncalibration, pooled across 2022 to 2025: is either signal biased for a group?",
  );
  console.log(
    "group                  n   model: said  played   bias   buckets: said   bias",
  );

  for (const pos of ["QB", "RB", "WR", "TE"]) {
    for (const band of ["25 and under", "26 to 28", "29 to 30", "31 and over"]) {
      const its = pooled.filter((r) =>
        r.position === pos && r.age !== undefined && ageBandOf(r.age) === band);

      if (its.length) {
        printGroup(`${pos} age ${band}`, its);
      }
    }
  }

  console.log();

  for (const band of ["0 to 8", "9 to 14", "15 to 17"]) {
    const its = pooled.filter((r) => gamesBandOf(r.gamesPrev) === band);

    if (its.length) {
      printGroup(`last season ${band}`, its);
    }
  }
}

await main();
