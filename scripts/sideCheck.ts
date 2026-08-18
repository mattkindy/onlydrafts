/**
 * Whether the two sides move a play at all.
 *
 * Conditioning on who is playing changed nothing per game, which is
 * either because teams do not differ or because the conditioning never
 * fires. This asks the model what it says for each side at one state.
 *
 * Run: npx tsx scripts/sideCheck.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { seededRng } from "../src/sim/rng.js";
import { fitPlayFactors, type PlayRow } from "../src/features/fitPlayFactors.js";
import type { Call } from "../src/model/playFactors.js";

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

async function main(): Promise<void> {
  const rows = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
  )).filter((r) => Number(r["season"]) < 2025).map((r) => ({
    down: Number(r["down"]), toGo: Number(r["togo"]),
    yardline: Number(r["yardline"]), call: (r["playType"] ?? "") as Call,
    offence: r["offense"] ?? "", defence: r["defense"] ?? "",
    margin: Number(r["margin"]) || 0, secondsLeft: Number(r["seconds"]) || 1800,
    yards: Number(r["yards"]) || 0, touchdown: Number(r["touchdown"]) || 0,
    player: r["player"] ?? "",
  })) as PlayRow[];

  const factors = fitPlayFactors(rows);
  const teams = [...new Set(rows.map((r) => r.offence))].filter(Boolean).sort();
  const rng = seededRng(4);
  const state = { down: 1, toGo: 10, yardline: 60, margin: 0, secondsLeft: 1800 };

  const runRates = teams.map((team) => factors.runs(state, team));
  const gained = teams.map((team) =>
    middle(Array.from({ length: 4000 }, () =>
      factors.gains(state, "run", "", rng, { offence: team }))));
  const allowed = teams.map((team) =>
    middle(Array.from({ length: 4000 }, () =>
      factors.gains(state, "run", "", rng, { defence: team }))));
  const league = middle(Array.from({ length: 4000 }, () =>
    factors.gains(state, "run", "", rng)));

  const spread = (values: number[]) => {
    const mid = middle(values);
    return Math.sqrt(middle(values.map((v) => (v - mid) ** 2)));
  };

  console.log(`first and ten at the 60, over ${teams.length} sides\n`);
  console.log(
    `  how often they run: ${(100 * Math.min(...runRates)).toFixed(0)}% to ` +
      `${(100 * Math.max(...runRates)).toFixed(0)}%, spread ` +
      `${(100 * spread(runRates)).toFixed(1)} points`,
  );
  console.log(
    `  what a carry gains: ${Math.min(...gained).toFixed(2)} to ` +
      `${Math.max(...gained).toFixed(2)}, spread ${spread(gained).toFixed(3)}, ` +
      `against a league ${league.toFixed(2)}`,
  );
  console.log(
    `  what a defence gives: ${Math.min(...allowed).toFixed(2)} to ` +
      `${Math.max(...allowed).toFixed(2)}, spread ${spread(allowed).toFixed(3)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
