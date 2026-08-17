/**
 * The same two networks, fed the men who were actually on the field.
 *
 * Given season-long roster averages the pairing terms bought nothing,
 * which is what you would expect: a team's average description barely
 * moves from snap to snap, so an offence times a defence adds little
 * to what the two say on their own. This describes each side from the eleven
 * who were out there for that play instead.
 *
 * Run: npx tsx scripts/onFieldEval.ts
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { rmse, spearman } from "../src/backtest/metrics.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import { splitLine } from "../src/data/csv.js";
import { RAW_DIR } from "../src/data/nflverse.js";
import { buildPlayerVectors, ATTRIBUTES } from "../src/features/playerVector.js";
import {
  DESCRIBED_DEFAULTS, fitDescribedNet, predict as predictPooled,
} from "../src/model/describedNet.js";
import {
  INTERACTION_DEFAULTS, fitInteractionNet, predict as predictPaired,
  type Described,
} from "../src/model/interactionNet.js";

const SEASONS = [2022, 2023, 2024, 2025];
const SEEDS = [1, 2, 3, 4, 5];

const distanceBand = (toGo: number) =>
  toGo <= 2 ? "short" : toGo <= 6 ? "medium" : toGo <= 10 ? "long" : "veryLong";

/** the average of however many of these men we can describe */
function averageOf(
  ids: string[],
  vectors: Map<string, { values: Float64Array }>,
): { values: Float64Array; known: number } {
  const out = new Float64Array(ATTRIBUTES.length);
  let known = 0;

  for (const id of ids) {
    const player = vectors.get(id);

    if (!player) {
      continue;
    }

    known++;

    for (let i = 0; i < out.length; i++) {
      out[i] = out[i]! + player.values[i]!;
    }
  }

  if (known > 1) {
    for (let i = 0; i < out.length; i++) {
      out[i] = out[i]! / known;
    }
  }

  return { values: out, known };
}

interface Play {
  season: number;
  yards: number;
  cell: string;
  on: Described[];
}

async function load(): Promise<Play[]> {
  const vectors = new Map<string, { values: Float64Array }>();

  for (const season of SEASONS) {
    for (const [id, player] of await buildPlayerVectors(season)) {
      // described from the season the play happened in, so a man who
      // improved is not described by what he became later
      vectors.set(`${season}|${id}`, player);
    }
  }

  const plays: Play[] = [];
  const reader = createInterface({
    input: createReadStream(join(RAW_DIR, "onField.csv")),
  });
  let header: string[] | undefined;
  const at: Record<string, number> = {};
  let missing = 0;

  for await (const line of reader) {
    if (!header) {
      header = splitLine(line);
      header.forEach((name, i) => { at[name] = i; });
      continue;
    }

    const c = splitLine(line);
    const season = Number(c[at["season"]!]);
    const idsOf = (text: string) =>
      text.split(";").filter(Boolean).map((id) => `${season}|${id}`);
    const offence = averageOf(idsOf(c[at["offenceOn"]!] ?? ""), vectors);
    const defence = averageOf(idsOf(c[at["defenceOn"]!] ?? ""), vectors);

    // a snap where we can describe nobody says nothing about anybody
    if (offence.known === 0 || defence.known === 0) {
      missing++;
      continue;
    }

    const down = Number(c[at["down"]!]);
    const toGo = Number(c[at["togo"]!]);
    const yardline = Number(c[at["yardline"]!]);
    const run = c[at["playType"]!] === "run";

    plays.push({
      season,
      yards: Number(c[at["yards"]!]) || 0,
      cell: [
        c[at["offense"]!], c[at["defense"]!], c[at["playType"]!],
        distanceBand(toGo),
      ].join(", "),
      on: [
        { kind: "offence", values: offence.values },
        { kind: "defence", values: defence.values },
        {
          kind: "situation",
          values: Float64Array.from([
            down === 1 ? 1 : 0, down === 2 ? 1 : 0,
            down === 3 ? 1 : 0, down === 4 ? 1 : 0,
            Math.min(toGo, 25) / 10,
            yardline / 100,
            yardline <= 10 ? 1 : 0,
            Number(c[at["margin"]!]) / 14,
            run ? 1 : 0,
          ]),
        },
      ],
    });
  }

  console.log(`${plays.length} plays, ${missing} dropped with nobody described`);
  return plays;
}

async function main(): Promise<void> {
  const all = await load();
  const train = all.filter((p) => p.season < 2025);
  const test = all.filter((p) => p.season === 2025);
  console.log(`${train.length} to learn from, ${test.length} to score on`);

  console.time("fitting");
  const task = [{ name: "yards", of: (i: number) => train[i]!.yards }];
  const pooled = SEEDS.map((seed) => fitDescribedNet(
    train.map((p) => p.on), task, { ...DESCRIBED_DEFAULTS, passes: 6, seed },
  ));
  const paired = SEEDS.map((seed) => fitInteractionNet(
    train.map((p) => p.on), task, { ...INTERACTION_DEFAULTS, passes: 6, seed },
  ));
  const flat = (on: Described[]) => [1, ...on.flatMap((e) => [...e.values])];
  const added = fitRidge(train.map((p) => flat(p.on)), train.map((p) => p.yards), 5);
  console.timeEnd("fitting");

  // A cell's prediction is the average over the plays in it, which is
  // the thing being compared to the average of what those plays gained.
  // Taking one play's answer instead measures a different quantity.
  const cells = new Map<string, Play[]>();

  for (const play of test) {
    const group = cells.get(play.cell) ?? [];
    group.push(play);
    cells.set(play.cell, group);
  }

  const big = [...cells.values()].filter((g) => g.length >= 40);
  const truth = big.map(
    (g) => g.reduce((a, p) => a + p.yards, 0) / g.length,
  );
  const middle = truth.reduce((a, b) => a + b, 0) / truth.length;
  const spread = Math.sqrt(
    truth.reduce((a, b) => a + (b - middle) ** 2, 0) / truth.length,
  );
  console.log(
    `\n${big.length} cells of both sides and the distance, seen 40+ times` +
      `\nthey average ${middle.toFixed(2)} yards and spread ${spread.toFixed(2)}`,
  );

  const onCells = (say: (p: Play) => number) =>
    big.map((g) => g.reduce((a, p) => a + say(p), 0) / g.length);

  const report = (label: string, values: number[][]) => {
    const errors = values.map((guess) => rmse(guess, truth));
    const ranks = values.map((guess) => spearman(guess, truth));
    const show = (nums: number[]) => {
      const mid = nums.reduce((a, b) => a + b, 0) / nums.length;
      const sd = Math.sqrt(
        nums.reduce((a, b) => a + (b - mid) ** 2, 0) / nums.length,
      );
      return `${mid.toFixed(3)} give or take ${sd.toFixed(3)}`;
    };
    console.log(
      "  " + label.padEnd(28) + "rmse " + show(errors).padEnd(28) +
      "rank " + show(ranks),
    );
  };

  console.log();
  report("descriptions added up", [onCells((p) => predictRidge(added, flat(p.on)))]);
  report("averaged together", pooled.map(
    (net) => onCells((p) => predictPooled(net, p.on, "yards")),
  ));
  report("kept apart and multiplied", paired.map(
    (net) => onCells((p) => predictPaired(net, p.on, "yards")),
  ));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
