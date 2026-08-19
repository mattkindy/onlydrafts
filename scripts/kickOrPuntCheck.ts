/**
 * On a fourth down it is not going for, does it kick or punt?
 *
 * The walk punts on 38.6% of drives where sides punt on 35.7%, and it
 * attempts 17.1% kicks where they attempt 18.4%. Aggression cannot
 * account for that: pushing it fixes the punts and breaks the scoring.
 * So the question is the other choice.
 *
 * Run: npx tsx scripts/kickOrPuntCheck.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { seededRng } from "../src/sim/rng.js";
import {
  fitFourthDown, climbTo, type FourthRow,
} from "../src/features/fitFourthDown.js";
import type { PlayState } from "../src/model/playFactors.js";

const SCORE_ON = 2025;
const DRAWS = 20;

async function main(): Promise<void> {
  const rows = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "plays.csv"), "utf8",
  )).filter((r) => Number(r["down"]) === 4);
  const asRow = (r: Record<string, string>): FourthRow => ({
    toGo: Number(r["togo"]), yardline: Number(r["yardline"]),
    margin: Number(r["margin"]) || 0, secondsLeft: Number(r["seconds"]) || 1800,
    choice: ["run", "pass"].includes(r["playType"] ?? "") ? "go"
      : r["playType"] === "field_goal" ? "kick" : "punt",
  });
  const learn = rows.filter((r) => Number(r["season"]) < SCORE_ON);
  const seasons = [...new Set(learn.map((r) => Number(r["season"])))];
  const fitted = fitFourthDown(
    learn.map(asRow), 60, 6, 1, climbTo(seasons, SCORE_ON),
  );
  const held = rows.filter((r) => Number(r["season"]) === SCORE_ON).map(asRow);
  const rng = seededRng(19);

  console.log(`${held.length} fourth downs in ${SCORE_ON}\n`);
  console.log(
    "  where it stood        n     go said v really    kick said v really" +
      "     punt said v really",
  );

  const zones: [string, (r: FourthRow) => boolean][] = [
    ["inside the twenty", (r) => r.yardline <= 20],
    ["the twenty to thirty", (r) => r.yardline > 20 && r.yardline <= 30],
    ["the thirty to forty", (r) => r.yardline > 30 && r.yardline <= 40],
    ["the forty to fifty", (r) => r.yardline > 40 && r.yardline <= 50],
    ["past midfield", (r) => r.yardline > 50],
  ];

  for (const [label, is] of zones) {
    const these = held.filter(is);

    if (these.length < 40) {
      continue;
    }

    const said = { go: 0, kick: 0, punt: 0 };

    for (const one of these) {
      const state: PlayState = {
        down: 4, toGo: one.toGo, yardline: one.yardline,
        margin: one.margin, secondsLeft: one.secondsLeft,
      };

      for (let i = 0; i < DRAWS; i++) {
        said[fitted.choose(state, rng)]++;
      }
    }

    const drew = these.length * DRAWS;
    const pair = (what: "go" | "kick" | "punt") =>
      `${(100 * said[what] / drew).toFixed(0)}% v ` +
      `${(100 * these.filter((r) => r.choice === what).length / these.length).toFixed(0)}%`;

    console.log(
      "  " + label.padEnd(22) + String(these.length).padStart(4) +
        pair("go").padStart(18) + pair("kick").padStart(22) +
        pair("punt").padStart(22),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
