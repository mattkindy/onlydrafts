/**
 * Does the level a play is scaled by average one?
 *
 * The walk gains four tenths of a yard less than sides do, and it
 * draws a past play and multiplies it by how good the man with the
 * ball is. If that multiplier averages below one over the plays the
 * walk actually generates then every drive is short, and the same
 * centring mistake cost three points a game this morning somewhere
 * else.
 *
 * Run: npx tsx scripts/levelCentreCheck.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { seededRng } from "../src/sim/rng.js";
import { fitPlayFactors, type PlayRow } from "../src/features/fitPlayFactors.js";
import { realCounts, drawnCounts, type Whom } from "../src/features/comparablePlays.js";
import type { Call, PlayState } from "../src/model/playFactors.js";

const SCORE_ON = 2025;
const DRAWS = 40;

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

async function main(): Promise<void> {
  const raw = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
  ));
  const asRow = (r: Record<string, string>) => ({
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
  const learn = raw.filter((r) => Number(r["season"]) < SCORE_ON).map(asRow);
  const held = raw.filter((r) => Number(r["season"]) === SCORE_ON).map(asRow);
  const factors = fitPlayFactors(learn as PlayRow[]);
  const rng = seededRng(53);
  const whom: Whom = "plays with a man on them";

  console.log(
    "asked about the plays a season really had, what comes back\n",
  );
  console.log("  call    plays   the model   what happened   the pool it draws from");

  for (const call of ["run", "pass"] as Call[]) {
    const asking = held.filter(
      (p) => p.call === call && realCounts(p, whom),
    ).filter((_, i) => i % 7 === 0);
    const drawn: number[] = [];
    /** the same spots asked about with nobody in particular */
    const nobody: number[] = [];

    for (const play of asking) {
      const state: PlayState = {
        down: play.down, toGo: play.toGo, yardline: play.yardline,
        margin: play.margin, secondsLeft: play.secondsLeft,
      };
      const sides = {
        offence: play.offence, defence: play.defence, passer: play.passer,
      };

      for (let i = 0; i < DRAWS; i++) {
        const his = factors.gains(state, call, play.player, rng, sides);
        const anyone = factors.gains(state, call, "", rng, sides);
        if (drawnCounts(call, his, whom)) drawn.push(his);
        if (drawnCounts(call, anyone, whom)) nobody.push(anyone);
      }
    }

    const truth = middle(
      held.filter((p) => p.call === call && realCounts(p, whom)).map((p) => p.yards),
    );
    console.log(
      "  " + call.padEnd(6) + String(asking.length).padStart(7) +
        middle(drawn).toFixed(2).padStart(12) +
        truth.toFixed(2).padStart(16) +
        middle(nobody).toFixed(2).padStart(24),
    );
  }

  console.log(
    "\n  the last column is the same spots with no man named, so it is\n" +
      "  the pool before anybody's own level is put on it. If naming the\n" +
      "  man moves it down, the level is not centred.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
