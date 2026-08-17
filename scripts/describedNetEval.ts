/**
 * Descriptions against invented vectors, on the plays.
 *
 * entityNet learned free numbers per entity and came out level with
 * adding the pieces up, which is what happens when there is not enough
 * data to learn a representation. This is fed the descriptions
 * instead, so the only thing left to learn is how to use them.
 *
 * Run: npx tsx scripts/describedNetEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { rmse, spearman } from "../src/backtest/metrics.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import { buildPlayerVectors, poolVectors, ATTRIBUTES } from "../src/features/playerVector.js";
import { loadWeeklyRosters } from "../src/data/nflverse.js";
import {
  DESCRIBED_DEFAULTS, fitDescribedNet, predict,
  type Described, type Task,
} from "../src/model/describedNet.js";

const SEASONS = [2022, 2023, 2024, 2025];

async function main(): Promise<void> {
  // every team's offence and defence, described by whoever was on it
  const describedTeams = new Map<string, Float64Array>();

  for (const season of SEASONS) {
    const players = await buildPlayerVectors(season);
    const byTeam = new Map<string, { skill: typeof players extends Map<string, infer V> ? V[] : never; defence: any[] }>();

    for (const row of await loadWeeklyRosters(season)) {
      const described = players.get(row.playerId);
      if (!described) continue;
      const side = byTeam.get(row.teamId) ?? { skill: [] as any[], defence: [] as any[] };

      if (["RB", "WR", "TE", "QB"].includes(described.position)) {
        if (!side.skill.some((p: any) => p.playerId === row.playerId)) side.skill.push(described);
      } else if (["DB", "DL", "LB"].includes(described.position)) {
        if (!side.defence.some((p: any) => p.playerId === row.playerId)) side.defence.push(described);
      }

      byTeam.set(row.teamId, side);
    }

    for (const [team, side] of byTeam) {
      describedTeams.set(`offence|${season}|${team}`, poolVectors(side.skill));
      describedTeams.set(`defence|${season}|${team}`, poolVectors(side.defence));
    }
  }

  const rows = parseCsv(
    await readFile(join(import.meta.dirname, "..", "data", "curated", "plays.csv"), "utf8"),
  ).filter((r) => ["run", "pass"].includes(r["playType"] ?? ""));

  const stateOf = (r: Record<string, string>) => Float64Array.from([
    Number(r["down"]) === 1 ? 1 : 0,
    Number(r["down"]) === 2 ? 1 : 0,
    Number(r["down"]) === 3 ? 1 : 0,
    Number(r["down"]) === 4 ? 1 : 0,
    Math.min(Number(r["togo"]), 25) / 10,
    Number(r["yardline"]) / 100,
    Number(r["yardline"]) <= 10 ? 1 : 0,
    Number(r["margin"]) / 14,
    r["playType"] === "run" ? 1 : 0,
  ]);

  const all = rows.map((r) => {
    const season = Number(r["season"]);
    return {
      season,
      target: Number(r["yards"]),
      on: [
        {
          kind: "offence",
          values: describedTeams.get(`offence|${season}|${r["offense"]}`) ??
            new Float64Array(ATTRIBUTES.length),
        },
        {
          kind: "defence",
          values: describedTeams.get(`defence|${season}|${r["defense"]}`) ??
            new Float64Array(ATTRIBUTES.length),
        },
        { kind: "situation", values: stateOf(r) },
      ] as Described[],
    };
  });

  const train = all.filter((e) => e.season < 2025);
  const test = all.filter((e) => e.season === 2025);
  console.log(`${train.length} plays to learn from, ${test.length} to score on\n`);

  console.time("fitting");
  const net = fitDescribedNet(
    train.map((e) => e.on),
    [{ name: "yards", of: (i: number) => train[i]!.target } as Task],
    { ...DESCRIBED_DEFAULTS, passes: 6 },
  );
  console.timeEnd("fitting");

  // the same descriptions, added up rather than combined
  const flat = (on: Described[]) => [1, ...on.flatMap((e) => [...e.values])];
  const weights = fitRidge(
    train.map((e) => flat(e.on)), train.map((e) => e.target), 5,
  );
  const actual = test.map((e) => e.target);

  console.log("\npredicting the yards a play gains\n");
  console.log("  model                            rmse   spearman");

  for (const [label, guess] of [
    ["the average always", test.map(() => train.reduce((a, e) => a + e.target, 0) / train.length)],
    ["descriptions added up", test.map((e) => predictRidge(weights, flat(e.on)))],
    ["descriptions combined", test.map((e) => predict(net, e.on, "yards"))],
  ] as [string, number[]][]) {
    console.log(
      "  " + label.padEnd(30) + rmse(guess, actual).toFixed(3).padStart(8) +
      spearman(guess, actual).toFixed(3).padStart(11),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
