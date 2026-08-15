// Simulates a 12-team 2024 league where every team drafts off last
// season's rankings and sets lineups by them too, except team A, which
// sets lineups with the weekly model. Run: npx tsx scripts/simLeague.ts

import { loadGames } from "../src/data/nflverse.js";
import {
  weeklyExamplesForSeason,
  weeklyRow,
} from "../src/features/weeklyModel.js";
import type { WeeklyExample } from "../src/features/weekly.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import { buildResidualModel } from "../src/backtest/intervals.js";
import { seededRng } from "../src/sim/rng.js";
import { drawWeekOutcomes, type PlayerWeek } from "../src/sim/season.js";
import { pickLineup } from "../src/sim/lineup.js";

const TRAIN_SEASONS = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023];
const SIM_SEASON = 2024;
const TEAMS = 12;
const SIMS = 1000;
const ROSTER_LIMITS: Record<string, number> = { QB: 2, RB: 4, WR: 4, TE: 2 };
const ROSTER_SIZE = 10;

function snakeOrder(round: number, teams: number): number[] {
  const order = Array.from({ length: teams }, (_, i) => i);
  return round % 2 === 0 ? order : order.reverse();
}

/** circle method round robin; team pairings for one week */
function pairings(week: number, teams: number): [number, number][] {
  const rotating = Array.from({ length: teams - 1 }, (_, i) => i + 1);
  const shift = week % (teams - 1);
  const rotated = [...rotating.slice(shift), ...rotating.slice(0, shift)];
  const ring = [0, ...rotated];
  const result: [number, number][] = [];

  for (let i = 0; i < teams / 2; i++) {
    result.push([ring[i]!, ring[teams - 1 - i]!]);
  }

  return result;
}

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

  const rosters: Set<string>[] = Array.from({ length: TEAMS }, () => new Set());
  const counts = Array.from({ length: TEAMS }, () => new Map<string, number>());
  let cursor = 0;

  for (let round = 0; round < ROSTER_SIZE; round++) {
    for (const team of snakeOrder(round, TEAMS)) {
      while (cursor < board.length) {
        const player = board[cursor]!;
        const have = counts[team]!.get(player.position) ?? 0;
        const taken = rosters.some((r) => r.has(player.playerId));

        if (!taken && have < (ROSTER_LIMITS[player.position] ?? 0)) {
          rosters[team]!.add(player.playerId);
          counts[team]!.set(player.position, have + 1);
          break;
        }

        cursor++;
      }

      cursor = 0;
    }
  }

  const byWeek = new Map<number, Map<string, PlayerWeek>>();
  const predictions = new Map<string, number>();

  for (const e of season) {
    const key = `${e.playerId}|${e.week}`;
    const predicted = predictRidge(weights, weeklyRow(e));
    predictions.set(key, predicted);

    const weekMap = byWeek.get(e.week) ?? new Map<string, PlayerWeek>();
    weekMap.set(e.playerId, {
      playerId: e.playerId,
      position: e.position,
      predicted,
      teamId: e.teamId,
      gameKey: `${e.week}|${[e.teamId, e.opponent].sort().join("@")}`,
    });
    byWeek.set(e.week, weekMap);
  }

  const weeks = [...byWeek.keys()].sort((a, b) => a - b);
  const staticValue = (id: string) => preseason.get(id)?.value ?? 0;
  const naiveWinTotals = new Array<number>(TEAMS).fill(0);
  const modelWinTotals = new Array<number>(TEAMS).fill(0);

  for (let sim = 0; sim < SIMS; sim++) {
    const rng = seededRng(sim + 1);
    const naiveWins = new Array<number>(TEAMS).fill(0);
    const modelWins = new Array<number>(TEAMS).fill(0);

    for (let w = 0; w < weeks.length; w++) {
      const weekMap = byWeek.get(weeks[w]!)!;
      const rostered = [...weekMap.values()].filter((p) =>
        rosters.some((r) => r.has(p.playerId)),
      );
      const outcomes = drawWeekOutcomes(rostered, residuals, rng);

      const pointsUnder = (team: number, useModel: boolean): number => {
        const candidates = rostered
          .filter((p) => rosters[team]!.has(p.playerId))
          .map((p) => ({
            playerId: p.playerId,
            position: p.position,
            score: useModel ? p.predicted : staticValue(p.playerId),
          }));

        let points = 0;

        for (const starter of pickLineup(candidates)) {
          points += outcomes.get(starter) ?? 0;
        }

        return points;
      };

      const naivePts = rosters.map((_, team) => pointsUnder(team, false));
      const modelPts = rosters.map((_, team) => pointsUnder(team, true));

      for (const [a, b] of pairings(w, TEAMS)) {
        if (naivePts[a]! > naivePts[b]!) {
          naiveWins[a]!++;
        } else {
          naiveWins[b]!++;
        }

        // counterfactual: one team switches to the model, opponent stays naive
        if (modelPts[a]! > naivePts[b]!) {
          modelWins[a]!++;
        }

        if (modelPts[b]! >= naivePts[a]!) {
          modelWins[b]!++;
        }
      }
    }

    for (let team = 0; team < TEAMS; team++) {
      naiveWinTotals[team]! += naiveWins[team]!;
      modelWinTotals[team]! += modelWins[team]!;
    }
  }

  console.log(`league of ${TEAMS}, ${weeks.length} weeks, ${SIMS} simulated seasons`);
  console.log(`all teams draft and start by last season's rankings;`);
  console.log(`each slot then replays with only that team using the weekly model\n`);
  console.log("slot  naive-wins  model-wins  lift");

  let liftSum = 0;

  for (let team = 0; team < TEAMS; team++) {
    const naive = naiveWinTotals[team]! / SIMS;
    const model = modelWinTotals[team]! / SIMS;
    liftSum += model - naive;
    console.log(
      `${String(team + 1).padStart(4)} ${naive.toFixed(2).padStart(11)} ${model.toFixed(2).padStart(11)} ${(model - naive >= 0 ? "+" : "") + (model - naive).toFixed(2)}`,
    );
  }

  console.log(
    `\naverage lift from model lineups: ${(liftSum / TEAMS >= 0 ? "+" : "") + (liftSum / TEAMS).toFixed(2)} wins over a ${weeks.length}-week season`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
