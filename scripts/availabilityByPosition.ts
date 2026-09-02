/**
 * What the availability model expects of each position, against what
 * that position actually plays.
 *
 * Counting only what a man was handed or thrown made every
 * quarterback look like a five touch player, and how much a man is
 * given is the second strongest signal of whether he stays on the
 * field. So the board expected quarterbacks to play four games fewer
 * than anybody else, which is not a thing that happens.
 *
 * Run: npx tsx scripts/availabilityByPosition.ts
 */

import { readAvailability } from "../src/features/availabilityData.js";
import { fitAvailability, predictAvailability } from "../src/features/gamesPlayed.js";

const SEASONS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
const { rowsFor } = await readAvailability(SEASONS);
const rows = SEASONS.flatMap((s) => rowsFor(s));
const mean = (its: number[]) =>
  its.length ? its.reduce((a, b) => a + b, 0) / its.length : 0;

console.log("pos    n   we expect   they played   off by");

for (const season of [2023, 2024, 2025]) {
  const before = rows.filter((r) => r.season < season && r.played !== undefined);
  const now = rows.filter((r) => r.season === season && r.played !== undefined);
  const fit = fitAvailability(before);

  console.log(`\n${season}`);

  for (const pos of ["QB", "RB", "WR", "TE"]) {
    /** the men worth starting, so a third string is not in the average */
    const its = now.filter((r) => r.position === pos && r.gamesPrev >= 8);

    if (!its.length) {
      continue;
    }

    const said = its.map((r) => predictAvailability(fit, r));
    const did = its.map((r) => r.played!);

    console.log(
      `${pos.padEnd(4)} ${String(its.length).padStart(4)}   ` +
      `${mean(said).toFixed(1).padStart(7)}   ${mean(did).toFixed(1).padStart(11)}` +
      `   ${(mean(said) - mean(did)).toFixed(1).padStart(6)}`,
    );
  }
}
