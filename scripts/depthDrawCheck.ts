/**
 * Where the yards go when a throw is drawn from its depth pool.
 *
 * Drawing a pass from the pool of throws at the receiver's own depth
 * should get both halves right at once, and instead it costs the walk
 * 1.8 points a game. This asks the factors directly, over the states a
 * drive really visits, rather than walking whole games to find out.
 *
 * Run: npx tsx scripts/depthDrawCheck.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { seededRng } from "../src/sim/rng.js";
import { fitPlayFactors, type PlayRow } from "../src/features/fitPlayFactors.js";
import { fitTargetDepth } from "../src/features/targetDepth.js";
import type { Call, PlayState } from "../src/model/playFactors.js";

const SCORE_ON = 2025;
const DRAWS = 40;

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

async function main(): Promise<void> {
  const rows = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
  ));
  const asPlay = (r: Record<string, string>): PlayRow => ({
    offence: r["offense"] ?? "", defence: r["defense"] ?? "",
    down: Number(r["down"]), toGo: Number(r["togo"]),
    yardline: Number(r["yardline"]), margin: Number(r["margin"]) || 0,
    secondsLeft: Number(r["seconds"]) || 1800,
    call: (r["playType"] ?? "") as Call,
    yards: Number(r["yards"]) || 0, touchdown: Number(r["touchdown"]) || 0,
    player: r["player"] ?? "", passer: r["passer"] ?? "",
    airYards: r["airYards"] === "" || r["airYards"] === undefined
      ? undefined : Number(r["airYards"]),
  });
  const learn = rows.filter((r) => Number(r["season"]) < SCORE_ON).map(asPlay);
  const held = rows.filter((r) => Number(r["season"]) === SCORE_ON).map(asPlay);
  const depth = fitTargetDepth(learn);
  const plain = fitPlayFactors(learn);
  const byDepth = fitPlayFactors(learn, undefined, { depth });

  console.log(
    `${learn.length} plays learned on, ${held.length} to ask about, ` +
      `depth known for ${depth.knownMen} men\n`,
  );

  const rng = seededRng(31);

  for (const call of ["pass", "run"] as Call[]) {
    const asking = held.filter((p) => p.call === call && p.player);
    const sample = asking.filter((_, i) => i % 11 === 0);
    const truth = middle(asking.map((p) => p.yards));
    const nothingReally =
      asking.filter((p) => p.yards <= 0).length / Math.max(1, asking.length);

    for (const [label, factors] of [
      ["one pool for the spot", plain], ["a pool per depth", byDepth],
    ] as [string, ReturnType<typeof fitPlayFactors>][]) {
      const drawn: number[] = [];

      for (const play of sample) {
        const state: PlayState = {
          down: play.down, toGo: play.toGo, yardline: play.yardline,
          margin: play.margin, secondsLeft: play.secondsLeft,
        };

        for (let i = 0; i < DRAWS; i++) {
          drawn.push(factors.gains(state, call, play.player, rng, {
            offence: play.offence, defence: play.defence, passer: play.passer,
          }));
        }
      }

      const nothing = drawn.filter((y) => y <= 0).length / Math.max(1, drawn.length);
      console.log(
        `  ${call.padEnd(5)} ${label.padEnd(24)}` +
          `${middle(drawn).toFixed(2).padStart(8)} yards` +
          `${(100 * nothing).toFixed(1).padStart(9)}% gain nothing`,
      );
    }

    console.log(
      `  ${call.padEnd(5)} ${"what really happened".padEnd(24)}` +
        `${truth.toFixed(2).padStart(8)} yards` +
        `${(100 * nothingReally).toFixed(1).padStart(9)}% gain nothing\n`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
