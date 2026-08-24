/**
 * What a side does on fourth down, band by band of the clock.
 *
 * A drive walked on its own is told 1800 seconds every time, and the
 * time bands put everything over 1500 together, so three of the four
 * bands were never simulated. A game played out spends two drives in
 * five in those three, and punts fall from 36% of drives to 26%.
 *
 * Run: npx tsx scripts/fourthByClockEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { seededRng } from "../src/sim/rng.js";
import { fitFourthDown, type FourthRow } from "../src/features/fitFourthDown.js";
import { timeBand, marginBand, type PlayState } from "../src/model/playFactors.js";

/** the fourth downs where a side actually chose, so not the flags */
const DECIDED = ["run", "pass", "field_goal", "punt"];

const SCORE_ON = 2025;
const DRAWS = 400;

const BANDS: [string, number][] = [
  ["over 25 minutes left", 0],
  ["25 minutes to 5", 1],
  ["5 minutes to 2", 2],
  ["the last 2 minutes", 3],
];

async function main(): Promise<void> {
  const plays = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "fourths.csv"), "utf8",
  ));
  const asRow = (r: Record<string, string>): FourthRow => ({
    toGo: Number(r["togo"]), yardline: Number(r["yardline"]),
    margin: Number(r["margin"]) || 0, secondsLeft: Number(r["seconds"]) || 1800,
    choice: ["run", "pass"].includes(r["playType"] ?? "") ? "go"
      : r["playType"] === "field_goal" ? "kick" : "punt",
  });
  const fourths = plays
    .filter((r) =>
      Number(r["down"]) === 4 && DECIDED.includes(r["playType"] ?? ""))
    .map((r) => ({ season: Number(r["season"]), ...asRow(r) }));
  const fitted = fitFourthDown(
    fourths.filter((r) => r.season < SCORE_ON) as FourthRow[],
    60, Number(process.env["STEADY"] ?? 40), 1,
  );
  const held = fourths.filter((r) => r.season === SCORE_ON);

  console.log(
    `${fourths.length} fourth downs, ${held.length} of them in ${SCORE_ON}\n`,
  );
  console.log(
    "how often a side goes for it, by the clock\n\n" +
      "  when                        fourth downs   really   the model",
  );

  const rng = seededRng(17);

  for (const [label, band] of BANDS) {
    const these = held.filter((r) => timeBand(r.secondsLeft) === band);

    if (these.length < 40) {
      console.log("  " + label.padEnd(28) + String(these.length).padStart(12) +
        "   too few to say");
      continue;
    }

    const went = these.filter((r) => r.choice === "go").length / these.length;
    let said = 0;

    // asked at the very spots that came up, so the mix of distances
    // and field position is the one that really happened
    for (const one of these) {
      const state: PlayState = {
        down: 4, toGo: one.toGo, yardline: one.yardline,
        margin: one.margin, secondsLeft: one.secondsLeft,
      };

      for (let i = 0; i < DRAWS / 20; i++) {
        if (fitted.choose(state, rng) === "go") {
          said++;
        }
      }
    }

    console.log(
      "  " + label.padEnd(28) + String(these.length).padStart(12) +
        `${(100 * went).toFixed(1)}%`.padStart(9) +
        `${(100 * said / (these.length * (DRAWS / 20))).toFixed(1)}%`.padStart(12),
    );
  }

  // and the same by score, since being behind is the other half of it
  console.log("\nand by the score\n");
  console.log("  when                        fourth downs   really   the model");

  for (const [label, band] of [
    ["two scores behind", 0], ["a score behind", 1], ["level", 2],
    ["a score ahead", 3], ["two scores ahead", 4],
  ] as [string, number][]) {
    const these = held.filter((r) => marginBand(r.margin) === band);

    if (these.length < 40) {
      console.log("  " + label.padEnd(28) + String(these.length).padStart(12) +
        "   too few to say");
      continue;
    }

    const went = these.filter((r) => r.choice === "go").length / these.length;
    let said = 0;

    for (const one of these) {
      const state: PlayState = {
        down: 4, toGo: one.toGo, yardline: one.yardline,
        margin: one.margin, secondsLeft: one.secondsLeft,
      };

      for (let i = 0; i < DRAWS / 20; i++) {
        if (fitted.choose(state, rng) === "go") {
          said++;
        }
      }
    }

    console.log(
      "  " + label.padEnd(28) + String(these.length).padStart(12) +
        `${(100 * went).toFixed(1)}%`.padStart(9) +
        `${(100 * said / (these.length * (DRAWS / 20))).toFixed(1)}%`.padStart(12),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
