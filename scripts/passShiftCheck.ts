// Raw effect check: for stayers under a new coordinator, does the
// direction of his pass-rate shift move next-season performance?
// Run: npx tsx scripts/passShiftCheck.ts

import {
  blended,
  buildSeasonData,
  examplesForTransition,
  fitBlendWeight,
  type SeasonExample,
} from "../src/features/seasonModel.js";

const SEASONS = [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];

async function main(): Promise<void> {
  const data = await buildSeasonData(SEASONS);
  const examples: SeasonExample[] = [];

  for (const target of SEASONS.slice(2)) {
    examples.push(...(await examplesForTransition(target, data)));
  }

  const weight = fitBlendWeight(examples);
  const stayers = examples.filter(
    (e) =>
      !e.moved &&
      e.ocChanged &&
      e.passShift !== 0 &&
      blended(e, weight) > 5 &&
      (e.position === "WR" || e.position === "TE" || e.position === "RB"),
  );

  console.log(`${stayers.length} stayers under a new coordinator with a measured shift`);
  console.log("group                          n   mean actual/expected");

  const groups: [string, (e: SeasonExample) => boolean][] = [
    ["catchers, passier OC (>+3%)", (e) => e.position !== "RB" && e.passShift > 0.03],
    ["catchers, runnier OC (<-3%)", (e) => e.position !== "RB" && e.passShift < -0.03],
    ["RBs, passier OC (>+3%)", (e) => e.position === "RB" && e.passShift > 0.03],
    ["RBs, runnier OC (<-3%)", (e) => e.position === "RB" && e.passShift < -0.03],
  ];

  for (const [label, match] of groups) {
    const members = stayers.filter(match);
    const ratios = members.map((e) =>
      Math.min(e.actualPpg / blended(e, weight), 3),
    );
    const mean = ratios.reduce((s, x) => s + x, 0) / ratios.length;
    console.log(`${label.padEnd(30)} ${String(members.length).padStart(3)}   ${mean.toFixed(3)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
