/**
 * Does keeping the sides apart and multiplying them buy anything?
 *
 * Both networks are fed the same descriptions: who is on the offence,
 * who is on the defence, and the state of the play. One averages them
 * together before learning, the other keeps a slot per side and adds
 * their products. Scored on what a configuration averages, since a
 * single snap's yardage is close to unpredictable and hides the
 * difference between any two models.
 *
 * Run: npx tsx scripts/interactionEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { rmse, spearman } from "../src/backtest/metrics.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import { buildPlayerVectors, poolVectors, ATTRIBUTES } from "../src/features/playerVector.js";
import { loadWeeklyRosters } from "../src/data/nflverse.js";
import {
  DESCRIBED_DEFAULTS, fitDescribedNet, predict as predictPooled,
} from "../src/model/describedNet.js";
import {
  INTERACTION_DEFAULTS, fitInteractionNet, predict as predictPaired,
  type Described,
} from "../src/model/interactionNet.js";

const SEASONS = [2022, 2023, 2024, 2025];
const SKILL = ["RB", "WR", "TE", "QB"];
const DEFENDERS = ["DB", "DL", "LB"];

const distanceBand = (toGo: number) =>
  toGo <= 2 ? "short" : toGo <= 6 ? "medium" : toGo <= 10 ? "long" : "veryLong";

async function describeTeams(): Promise<Map<string, Float64Array>> {
  const described = new Map<string, Float64Array>();

  for (const season of SEASONS) {
    const players = await buildPlayerVectors(season);
    const byTeam = new Map<string, { skill: any[]; defence: any[] }>();

    for (const row of await loadWeeklyRosters(season)) {
      const player = players.get(row.playerId);

      if (!player) {
        continue;
      }

      const side = byTeam.get(row.teamId) ?? { skill: [], defence: [] };
      const into = SKILL.includes(player.position) ? side.skill
        : DEFENDERS.includes(player.position) ? side.defence
        : null;

      if (into && !into.some((p) => p.playerId === row.playerId)) {
        into.push(player);
      }

      byTeam.set(row.teamId, side);
    }

    for (const [team, side] of byTeam) {
      described.set(`offence|${season}|${team}`, poolVectors(side.skill));
      described.set(`defence|${season}|${team}`, poolVectors(side.defence));
    }
  }

  return described;
}

async function main(): Promise<void> {
  const teams = await describeTeams();
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

  const blank = new Float64Array(ATTRIBUTES.length);
  const all = rows.map((r) => {
    const season = Number(r["season"]);
    return {
      season,
      yards: Number(r["yards"]),
      // a cell has to vary the sides as well as the state, or the
      // pairing terms have nothing to be right or wrong about
      cell: [
        r["offense"], r["defense"], r["playType"],
        distanceBand(Number(r["togo"])),
      ].join(", "),
      wideCell: [r["offense"], r["playType"], distanceBand(Number(r["togo"]))].join(", "),
      on: [
        {
          kind: "offence",
          values: teams.get(`offence|${season}|${r["offense"]}`) ?? blank,
        },
        {
          kind: "defence",
          values: teams.get(`defence|${season}|${r["defense"]}`) ?? blank,
        },
        { kind: "situation", values: stateOf(r) },
      ] as Described[],
    };
  });

  const train = all.filter((e) => e.season < 2025);
  const test = all.filter((e) => e.season === 2025);
  console.log(`${train.length} plays to learn from, ${test.length} to score on`);

  console.time("fitting");
  const task = [{ name: "yards", of: (i: number) => train[i]!.yards }];
  // both nets start from random numbers, so one fit of each says
  // nothing; run several and report how much the answer moves
  const SEEDS = [1, 2, 3, 4, 5];
  const pooledSeeds = SEEDS.map((seed) => fitDescribedNet(
    train.map((e) => e.on), task, { ...DESCRIBED_DEFAULTS, passes: 6, seed },
  ));
  const pairedSeeds = SEEDS.map((seed) => fitInteractionNet(
    train.map((e) => e.on), task, { ...INTERACTION_DEFAULTS, passes: 6, seed },
  ));
  const pooled = pooledSeeds[0]!;
  const paired = pairedSeeds[0]!;
  const flat = (on: Described[]) => [1, ...on.flatMap((e) => [...e.values])];
  const added = fitRidge(train.map((e) => flat(e.on)), train.map((e) => e.yards), 5);
  console.timeEnd("fitting");

  const said = {
    "descriptions added up": (e: (typeof all)[number]) => predictRidge(added, flat(e.on)),
    "averaged together": (e: (typeof all)[number]) => predictPooled(pooled, e.on, "yards"),
    "kept apart and multiplied": (e: (typeof all)[number]) => predictPaired(paired, e.on, "yards"),
  };

  // a cell's prediction is the average over its plays, since that is
  // what gets compared to the average of what those plays gained
  const score = (of: (e: (typeof all)[number]) => string, least: number) => {
    const cells = new Map<string, (typeof all)[number][]>();

    for (const play of test) {
      const key = of(play);
      const group = cells.get(key) ?? [];
      group.push(play);
      cells.set(key, group);
    }

    return [...cells.values()]
      .filter((g) => g.length >= least)
      .map((g) => ({
        yards: g.map((p) => p.yards),
        guess: Object.fromEntries(
          Object.entries(said).map(([name, get]) => [
            name, g.reduce((a, p) => a + get(p), 0) / g.length,
          ]),
        ) as Record<string, number>,
      }));
  };

  for (const [label, of, least] of [
    ["both sides and the distance", (e: (typeof all)[number]) => e.cell, 40],
    ["the offence and the distance", (e: (typeof all)[number]) => e.wideCell, 100],
  ] as [string, (e: (typeof all)[number]) => string, number][]) {
    const big = score(of, least);
    const truth = big.map((c) => c.yards.reduce((a, b) => a + b, 0) / c.yards.length);
    const middle = truth.reduce((a, b) => a + b, 0) / truth.length;
    const spread = Math.sqrt(
      truth.reduce((a, b) => a + (b - middle) ** 2, 0) / truth.length,
    );

    console.log(`\ncells by ${label}: ${big.length} of them, seen ${least}+ times`);
    console.log(`they average ${middle.toFixed(2)} yards and spread ${spread.toFixed(2)}`);
    console.log("  model                          rmse   rank");

    for (const name of Object.keys(said)) {
      const guess = big.map((c) => c.guess[name]!);
      console.log(
        "  " + name.padEnd(28) + rmse(guess, truth).toFixed(3).padStart(7) +
        spearman(guess, truth).toFixed(3).padStart(8),
      );
    }
  }

  // the same comparison once per seed, so the gap can be read against
  // how much either model moves on its own
  const perSeed = { averaged: [] as number[], multiplied: [] as number[] };
  const cellsOf = (of: (e: (typeof all)[number]) => string, least: number) => {
    const groups = new Map<string, (typeof all)[number][]>();

    for (const play of test) {
      const key = of(play);
      const group = groups.get(key) ?? [];
      group.push(play);
      groups.set(key, group);
    }

    return [...groups.values()]
      .filter((g) => g.length >= least)
      .map((g) => ({ yards: g.map((p) => p.yards), plays: g }));
  };
  const bigCells = cellsOf((e) => e.cell, 40);
  const cellTruth = bigCells.map((c) => c.yards.reduce((a, b) => a + b, 0) / c.yards.length);

  for (let i = 0; i < SEEDS.length; i++) {
    perSeed.averaged.push(rmse(
      bigCells.map((c) => c.plays.reduce(
        (a, p) => a + predictPooled(pooledSeeds[i]!, p.on, "yards"), 0) / c.plays.length),
      cellTruth,
    ));
    perSeed.multiplied.push(rmse(
      bigCells.map((c) => c.plays.reduce(
        (a, p) => a + predictPaired(pairedSeeds[i]!, p.on, "yards"), 0) / c.plays.length),
      cellTruth,
    ));
  }

  const summarise = (values: number[]) => {
    const middle = values.reduce((a, b) => a + b, 0) / values.length;
    const spread = Math.sqrt(
      values.reduce((a, b) => a + (b - middle) ** 2, 0) / values.length,
    );
    return `${middle.toFixed(3)} give or take ${spread.toFixed(3)}`;
  };

  console.log(`\nover ${SEEDS.length} starts, error on the both-sides cells`);
  console.log("  averaged together          " + summarise(perSeed.averaged));
  console.log("  kept apart and multiplied  " + summarise(perSeed.multiplied));

  const actual = test.map((e) => e.yards);
  console.log("\non single plays, where nothing separates them");
  console.log("  model                          rmse   rank");

  for (const [name, get] of Object.entries(said)) {
    const guess = test.map(get);
    console.log(
      "  " + name.padEnd(28) + rmse(guess, actual).toFixed(3).padStart(7) +
      spearman(guess, actual).toFixed(3).padStart(8),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
