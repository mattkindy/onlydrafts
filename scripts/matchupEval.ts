/**
 * The network's read on a matchup, put where the team play counts are.
 *
 * The walk bends a play by how many yards each side has managed at that
 * state, which cannot see a defence whose men have changed. The network
 * reads both sides from the players on the field, which is what it was
 * built for and where it beat the pooled version, .618 against .579.
 *
 * Run: npx tsx scripts/matchupEval.ts
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { splitLine } from "../src/data/csv.js";
import { RAW_DIR } from "../src/data/nflverse.js";
import { buildPlayerVectors, ATTRIBUTES } from "../src/features/playerVector.js";
import { matchup } from "../src/features/defenceStrength.js";
import {
  INTERACTION_DEFAULTS, fitInteractionNet, type Described,
} from "../src/model/interactionNet.js";

const LEARN = [2022, 2023, 2024];
const SCORE_ON = 2025;

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

const stateOf = (run: boolean) =>
  Float64Array.from([1, 0, 0, 0, 1.0, 0.6, 0, 0, run ? 1 : 0]);

async function main(): Promise<void> {
  const vectors = new Map<string, Float64Array>();

  for (const season of [...LEARN, SCORE_ON]) {
    for (const [id, man] of await buildPlayerVectors(season - 1)) {
      vectors.set(`${season}|${id}`, man.values);
    }
  }

  const averageOf = (ids: string[], season: number) => {
    const out = new Float64Array(ATTRIBUTES.length);
    let known = 0;

    for (const id of ids) {
      const man = vectors.get(`${season}|${id}`);
      if (!man) continue;
      known++;
      for (let i = 0; i < out.length; i++) out[i] = out[i]! + man[i]!;
    }

    if (known > 1) for (let i = 0; i < out.length; i++) out[i] = out[i]! / known;
    return out;
  };

  const learn: { on: Described[]; yards: number }[] = [];
  const sides = new Map<string, { offence: Float64Array[]; defence: Float64Array[] }>();
  const reader = createInterface({
    input: createReadStream(join(RAW_DIR, "onField.csv")),
  });
  let header: string[] | undefined;
  const at: Record<string, number> = {};

  for await (const line of reader) {
    if (!header) {
      header = splitLine(line);
      header.forEach((name, i) => { at[name] = i; });
      continue;
    }

    const c = splitLine(line);
    const season = Number(c[at["season"]!]);
    const ids = (text: string) => text.split(";").filter(Boolean);
    const offence = averageOf(ids(c[at["offenceOn"]!] ?? ""), season);
    const defence = averageOf(ids(c[at["defenceOn"]!] ?? ""), season);

    if (LEARN.includes(season)) {
      learn.push({
        yards: Number(c[at["yards"]!]) || 0,
        on: [
          { kind: "offence", values: offence },
          { kind: "defence", values: defence },
          { kind: "situation", values: stateOf(c[at["playType"]!] === "run") },
        ],
      });
    }

    if (season === SCORE_ON) {
      for (const [team, which, values] of [
        [c[at["offense"]!] ?? "", "offence", offence],
        [c[at["defense"]!] ?? "", "defence", defence],
      ] as [string, "offence" | "defence", Float64Array][]) {
        const own = sides.get(team) ?? { offence: [], defence: [] };
        own[which].push(values);
        sides.set(team, own);
      }
    }
  }

  const net = fitInteractionNet(
    learn.map((s) => s.on),
    [{ name: "yards", of: (i: number) => learn[i]!.yards }],
    { ...INTERACTION_DEFAULTS, passes: 6 },
  );

  const pool = (rows: Float64Array[]) => {
    const out = new Float64Array(ATTRIBUTES.length);
    for (const row of rows) {
      for (let i = 0; i < out.length; i++) out[i] = out[i]! + row[i]!;
    }
    for (let i = 0; i < out.length; i++) out[i] = out[i]! / Math.max(1, rows.length);
    return out;
  };

  const averageOffence = pool(learn.map((s) => s.on[0]!.values));
  const averageDefence = pool(learn.map((s) => s.on[1]!.values));
  const teams = [...sides.keys()].sort();

  const spread = (values: number[]) => {
    const mid = middle(values);
    return Math.sqrt(middle(values.map((v) => (v - mid) ** 2)));
  };

  const runs: number[] = [];
  const passes: number[] = [];

  for (const home of teams) {
    for (const away of teams) {
      if (home === away) continue;
      const bend = matchup(
        net, pool(sides.get(home)!.offence), pool(sides.get(away)!.defence),
        averageOffence, averageDefence, stateOf,
      );
      runs.push(bend.run);
      passes.push(bend.pass);
    }
  }

  console.log(
    `every pairing of ${teams.length} sides, ${runs.length} of them\n` +
      `  what it does to a carry: ${Math.min(...runs).toFixed(3)} to ` +
      `${Math.max(...runs).toFixed(3)}, spread ${spread(runs).toFixed(3)}\n` +
      `  and to a throw:          ${Math.min(...passes).toFixed(3)} to ` +
      `${Math.max(...passes).toFixed(3)}, spread ${spread(passes).toFixed(3)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
