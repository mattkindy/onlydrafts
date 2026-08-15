// Simulates the 2024 fantasy season for two snake-drafted rosters,
// with lineups set by three policies: hindsight, the weekly model, and
// preseason rankings. Run: npx tsx scripts/simSeason.ts

import { loadGames } from "../src/data/nflverse.js";
import {
  weeklyExamplesForSeason,
  weeklyRow,
} from "../src/features/weeklyModel.js";
import type { WeeklyExample } from "../src/features/weekly.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import { buildResidualModel } from "../src/backtest/intervals.js";
import { seededRng } from "../src/sim/rng.js";
import {
  simulateSeason,
  type PlayerWeek,
  type PolicyName,
} from "../src/sim/season.js";

const TRAIN_SEASONS = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023];
const SIM_SEASON = 2024;
const SIMS = 2000;
const ROSTER_LIMITS: Record<string, number> = { QB: 2, RB: 4, WR: 4, TE: 2 };
const ROSTER_SIZE = 10;

async function main(): Promise<void> {
  const games = await loadGames();
  const train: WeeklyExample[] = [];

  for (const season of TRAIN_SEASONS) {
    train.push(...(await weeklyExamplesForSeason(season, games)));
  }

  const weights = fitRidge(
    train.map(weeklyRow),
    train.map((e) => e.target),
    25,
  );
  const residuals = buildResidualModel(
    train.map((e) => ({
      position: e.position,
      predicted: predictRidge(weights, weeklyRow(e)),
      actual: e.target,
    })),
    5,
  );

  const season = await weeklyExamplesForSeason(SIM_SEASON, games);

  // preseason value: last season's points per game, the naive draft board
  const preseason = new Map<string, { position: string; value: number }>();

  for (const e of season) {
    const existing = preseason.get(e.playerId);

    if (!existing || e.prevPpg > existing.value) {
      preseason.set(e.playerId, { position: e.position, value: e.prevPpg });
    }
  }

  const board = [...preseason.entries()]
    .map(([playerId, { position, value }]) => ({ playerId, position, value }))
    .sort((a, b) => b.value - a.value);

  const rosters: string[][] = [[], []];
  const counts = [new Map<string, number>(), new Map<string, number>()];
  let pick = 0;

  for (const player of board) {
    if (rosters.every((r) => r.length >= ROSTER_SIZE)) {
      break;
    }

    // snake order: A B B A A B B A ...
    const team = [0, 1, 1, 0][pick % 4]!;
    const other = 1 - team;
    const chooser = rosters[team]!.length < ROSTER_SIZE ? team : other;
    const limit = ROSTER_LIMITS[player.position] ?? 0;
    const have = counts[chooser]!.get(player.position) ?? 0;

    if (rosters[chooser]!.length >= ROSTER_SIZE || have >= limit) {
      continue;
    }

    rosters[chooser]!.push(player.playerId);
    counts[chooser]!.set(player.position, have + 1);
    pick++;
  }

  const weeksFor = (roster: string[]): PlayerWeek[][] => {
    const set = new Set(roster);
    const byWeek = new Map<number, PlayerWeek[]>();

    for (const e of season) {
      if (!set.has(e.playerId)) {
        continue;
      }

      const list = byWeek.get(e.week) ?? [];
      list.push({
        playerId: e.playerId,
        position: e.position,
        predicted: predictRidge(weights, weeklyRow(e)),
      });
      byWeek.set(e.week, list);
    }

    return [...byWeek.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  };

  const staticValues = new Map(
    [...preseason.entries()].map(([id, { value }]) => [id, value]),
  );

  const teamWeeks = rosters.map(weeksFor);
  const sums: Record<PolicyName, number>[] = [
    { hindsight: 0, model: 0, naive: 0 },
    { hindsight: 0, model: 0, naive: 0 },
  ];
  let winsA = 0;

  for (let sim = 0; sim < SIMS; sim++) {
    const perTeam: number[] = [];

    for (let team = 0; team < 2; team++) {
      const result = simulateSeason(
        teamWeeks[team]!,
        residuals,
        staticValues,
        seededRng(sim * 2 + team + 1),
      );

      for (const policy of Object.keys(sums[team]!) as PolicyName[]) {
        sums[team]![policy] += result.meanPoints[policy];
      }

      perTeam.push(result.meanPoints.model);
    }

    if (perTeam[0]! > perTeam[1]!) {
      winsA++;
    }
  }

  for (let team = 0; team < 2; team++) {
    const mean = (policy: PolicyName) => sums[team]![policy] / SIMS;
    const gapClosed =
      (mean("model") - mean("naive")) / (mean("hindsight") - mean("naive"));

    console.log(`team ${team === 0 ? "A" : "B"} (${rosters[team]!.length} players):`);
    console.log(
      `  weekly points: hindsight ${mean("hindsight").toFixed(1)}, model ${mean("model").toFixed(1)}, naive ${mean("naive").toFixed(1)}`,
    );
    console.log(
      `  model closes ${(gapClosed * 100).toFixed(0)}% of the naive-to-hindsight gap`,
    );
  }

  console.log(
    `\nhead-to-head under the model policy: team A wins ${((winsA / SIMS) * 100).toFixed(1)}% of ${SIMS} simulated seasons`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
