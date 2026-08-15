// Measures draft skill in wins: one team drafts off the season model's
// projections while eleven draft off last season's rankings, rotated
// through every slot. Run: npx tsx scripts/simDraft.ts

import { loadGames } from "../src/data/nflverse.js";
import {
  weeklyExamplesForSeason,
  weeklyRow,
} from "../src/features/weeklyModel.js";
import type { WeeklyExample } from "../src/features/weekly.js";
import {
  buildSeasonData,
  examplesForTransition,
  fitSeasonModel,
  projectDraftBoard,
  type SeasonExample,
} from "../src/features/seasonModel.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import { buildResidualModel } from "../src/backtest/intervals.js";
import { seededRng } from "../src/sim/rng.js";
import { drawWeekOutcomes, type PlayerWeek } from "../src/sim/season.js";
import { pickLineup } from "../src/sim/lineup.js";

const WEEKLY_TRAIN = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023];
const SEASON_RANGE = [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024];
const SIM_SEASON = 2024;
const TEAMS = 12;
const SIMS_PER_SLOT = 300;
const ROSTER_LIMITS: Record<string, number> = { QB: 2, RB: 4, WR: 4, TE: 2 };
const ROSTER_SIZE = 10;

function snakeOrder(round: number, teams: number): number[] {
  const order = Array.from({ length: teams }, (_, i) => i);
  return round % 2 === 0 ? order : order.reverse();
}

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

interface BoardEntry {
  playerId: string;
  position: string;
  value: number;
}

function draftRosters(
  boards: BoardEntry[][],
  modelSlot: number,
): Set<string>[] {
  const rosters: Set<string>[] = Array.from({ length: TEAMS }, () => new Set());
  const counts = Array.from({ length: TEAMS }, () => new Map<string, number>());
  const taken = new Set<string>();

  for (let round = 0; round < ROSTER_SIZE; round++) {
    for (const team of snakeOrder(round, TEAMS)) {
      const board = boards[team === modelSlot ? 1 : 0]!;

      for (const player of board) {
        const have = counts[team]!.get(player.position) ?? 0;

        if (
          !taken.has(player.playerId) &&
          have < (ROSTER_LIMITS[player.position] ?? 0)
        ) {
          rosters[team]!.add(player.playerId);
          counts[team]!.set(player.position, have + 1);
          taken.add(player.playerId);
          break;
        }
      }
    }
  }

  return rosters;
}

async function main(): Promise<void> {
  const games = await loadGames();
  const weeklyTrain: WeeklyExample[] = [];

  for (const season of WEEKLY_TRAIN) {
    weeklyTrain.push(...(await weeklyExamplesForSeason(season, games)));
  }

  const weeklyWeights = fitRidge(
    weeklyTrain.map(weeklyRow),
    weeklyTrain.map((e) => e.target),
    25,
  );
  const residuals = buildResidualModel(
    weeklyTrain.map((e) => ({
      position: e.position,
      predicted: predictRidge(weeklyWeights, weeklyRow(e)),
      actual: e.target,
    })),
    5,
  );

  const seasonData = await buildSeasonData(SEASON_RANGE);
  const seasonTrain: SeasonExample[] = [];

  for (const target of SEASON_RANGE.slice(2, -1)) {
    seasonTrain.push(...(await examplesForTransition(target, seasonData)));
  }

  const fit = fitSeasonModel(seasonTrain);
  const projections = await projectDraftBoard(SIM_SEASON, seasonData, fit);

  const season = await weeklyExamplesForSeason(SIM_SEASON, games);
  const naiveValue = new Map<string, { position: string; value: number }>();

  for (const e of season) {
    const existing = naiveValue.get(e.playerId);

    if (!existing || e.prevPpg > existing.value) {
      naiveValue.set(e.playerId, { position: e.position, value: e.prevPpg });
    }
  }

  const naiveBoard: BoardEntry[] = [...naiveValue.entries()]
    .map(([playerId, { position, value }]) => ({ playerId, position, value }))
    .sort((a, b) => b.value - a.value);
  const modelBoard: BoardEntry[] = naiveBoard
    .map((entry) => ({
      ...entry,
      value: projections.get(entry.playerId) ?? 0,
    }))
    .sort((a, b) => b.value - a.value);

  // no waivers here, so replacement is the last player a league this
  // shape actually rosters, near teams times the position limit
  const REPLACEMENT_RANK: Record<string, number> = { QB: 20, RB: 40, WR: 40, TE: 16 };

  const vorBoard = (base: BoardEntry[]): BoardEntry[] => {
    const byPosition = new Map<string, BoardEntry[]>();

    for (const entry of base) {
      const list = byPosition.get(entry.position) ?? [];
      list.push(entry);
      byPosition.set(entry.position, list);
    }

    const replacement = new Map<string, number>();

    for (const [position, list] of byPosition) {
      list.sort((a, b) => b.value - a.value);
      const rank = REPLACEMENT_RANK[position] ?? 12;
      replacement.set(position, list[Math.min(rank, list.length) - 1]?.value ?? 0);
    }

    return base
      .map((entry) => ({
        ...entry,
        value: entry.value - (replacement.get(entry.position) ?? 0),
      }))
      .sort((a, b) => b.value - a.value);
  };

  const byWeek = new Map<number, PlayerWeek[]>();

  for (const e of season) {
    const list = byWeek.get(e.week) ?? [];
    list.push({
      playerId: e.playerId,
      position: e.position,
      predicted: predictRidge(weeklyWeights, weeklyRow(e)),
      teamId: e.teamId,
      gameKey: `${e.week}|${[e.teamId, e.opponent].sort().join("@")}`,
    });
    byWeek.set(e.week, list);
  }

  const weeks = [...byWeek.keys()].sort((a, b) => a - b);
  const actualPoints = new Map<string, number>();

  for (const e of season) {
    actualPoints.set(`${e.playerId}|${e.week}`, e.target);
  }

  const evaluateBoard = (
    challenger: BoardEntry[],
    label: string,
    realized = false,
  ): void => {
    const challengerValue = new Map(
      challenger.map((entry) => [entry.playerId, entry.value]),
    );
    let challengerSum = 0;
    let fieldSum = 0;

    for (let slot = 0; slot < TEAMS; slot++) {
      const rosters = draftRosters([naiveBoard, challenger], slot);
      let slotChallengerWins = 0;
      let slotFieldWins = 0;

      const sims = realized ? 1 : SIMS_PER_SLOT;

      for (let sim = 0; sim < sims; sim++) {
        const rng = seededRng(slot * SIMS_PER_SLOT + sim + 1);

        for (let w = 0; w < weeks.length; w++) {
          const rostered = byWeek
            .get(weeks[w]!)!
            .filter((p) => rosters.some((r) => r.has(p.playerId)));
          const outcomes = realized
            ? new Map(
                rostered.map((p) => [
                  p.playerId,
                  actualPoints.get(`${p.playerId}|${weeks[w]}`) ?? 0,
                ]),
              )
            : drawWeekOutcomes(rostered, residuals, rng);

          const points = rosters.map((roster, team) => {
            const candidates = rostered
              .filter((p) => roster.has(p.playerId))
              .map((p) => ({
                playerId: p.playerId,
                position: p.position,
                score:
                  team === slot
                    ? challengerValue.get(p.playerId) ?? 0
                    : naiveValue.get(p.playerId)?.value ?? 0,
              }));

            let total = 0;

            for (const starter of pickLineup(candidates)) {
              total += outcomes.get(starter) ?? 0;
            }

            return total;
          });

          for (const [a, b] of pairings(w, TEAMS)) {
            const winner = points[a]! > points[b]! ? a : b;

            if (winner === slot) {
              slotChallengerWins++;
            } else {
              slotFieldWins++;
            }
          }
        }
      }

      challengerSum += slotChallengerWins / sims;
      fieldSum += slotFieldWins / sims / (TEAMS - 1);
    }

    console.log(
      `${label.padEnd(22)} ${(challengerSum / TEAMS).toFixed(2)} wins vs field ${(fieldSum / TEAMS).toFixed(2)}`,
    );
  };

  console.log("challenger drafts its board, eleven others draft last season's rankings;");
  console.log("everyone starts by last season's rankings, averaged over all 12 slots\n");

  evaluateBoard(modelBoard, "model projections");
  evaluateBoard(vorBoard(naiveBoard), "naive + replacement");
  evaluateBoard(vorBoard(modelBoard), "model + replacement");

  console.log("\nsame boards scored against the season that actually happened:");
  evaluateBoard(modelBoard, "model projections", true);
  evaluateBoard(vorBoard(naiveBoard), "naive + replacement", true);
  evaluateBoard(vorBoard(modelBoard), "model + replacement", true);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
