// Prints the 2025 draft board with model projections, deviation from
// the naive board, feature flags, and what actually happened, as raw
// material for a qualitative review. Run: npx tsx scripts/review2025.ts

import {
  buildSeasonData,
  examplesForTransition,
  fitSeasonModel,
  predictSeasonBlend,
  projectDraftExamples,
  type SeasonExample,
} from "../src/features/seasonModel.js";

const SEASONS = [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];

async function main(): Promise<void> {
  const data = await buildSeasonData(SEASONS);
  const train: SeasonExample[] = [];

  for (const target of SEASONS.slice(2, -1)) {
    train.push(...(await examplesForTransition(target, data)));
  }

  const fit = fitSeasonModel(train);
  const board = await projectDraftExamples(2025, data);
  const actual = data.get(2025)!.summaries;
  const names = data.get(2024)!.summaries;

  const rows = board
    .map((e) => ({
      e,
      name: names.get(e.playerId)?.playerName ?? e.playerId,
      projection: predictSeasonBlend(fit, e),
      actualPpg: actual.get(e.playerId)?.pointsPerGame,
      actualGames: actual.get(e.playerId)?.games ?? 0,
    }))
    .sort((a, b) => b.e.prevPpg - a.e.prevPpg);

  const byProjection = [...rows].sort((a, b) => b.projection - a.projection);
  const modelRank = new Map(byProjection.map((r, i) => [r.e.playerId, i + 1]));

  console.log(
    "naiveRk mdlRk name                        pos age prevPpg proj  flags                actual  g",
  );

  rows.slice(0, 45).forEach((r, i) => {
    const flags = [
      r.e.moved ? "moved" : "",
      r.e.group === "skill-stayer-new-qb" || r.e.group === "qb-mover" ? "newQB" : "",
      r.e.ocChanged ? "newOC" : "",
      r.e.ocReunion ? "reunion" : "",
      r.e.age !== undefined && r.e.age >= 29 ? "29+" : "",
      r.e.gamesPrev <= 12 ? `${r.e.gamesPrev}g` : "",
      r.e.tdPointShare >= 0.45 ? "tdHeavy" : "",
      r.e.rookieCapital >= 0.5 ? "rookieComp" : "",
    ]
      .filter(Boolean)
      .join(",");

    console.log(
      `${String(i + 1).padStart(7)} ${String(modelRank.get(r.e.playerId)).padStart(5)} ${r.name.padEnd(27)} ${r.e.position.padEnd(3)} ${String(r.e.age ?? "?").padStart(3)} ${r.e.prevPpg.toFixed(1).padStart(7)} ${r.projection.toFixed(1).padStart(5)} ${flags.padEnd(20)} ${(r.actualPpg?.toFixed(1) ?? "out").padStart(6)} ${String(r.actualGames).padStart(2)}`,
    );
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
