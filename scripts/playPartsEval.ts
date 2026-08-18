/**
 * The parts of a play, checked one at a time.
 *
 * A play is a choice of call, a length of time, and an outcome. The
 * model has the call and the outcome and no notion of time at all,
 * which is why a game has to be handed a number of drives rather than
 * running until the clock says stop.
 *
 * Run: npx tsx scripts/playPartsEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

interface Play {
  season: number;
  week: number;
  offence: string;
  down: number;
  toGo: number;
  yardline: number;
  margin: number;
  secondsLeft: number;
  call: string;
  yards: number;
  touchdown: number;
  /** how long until the next snap, from the clock between them */
  took?: number;
}

async function main(): Promise<void> {
  const plays: Play[] = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
  )).map((r) => ({
    season: Number(r["season"]), week: Number(r["week"]),
    offence: r["offense"] ?? "", down: Number(r["down"]),
    toGo: Number(r["togo"]), yardline: Number(r["yardline"]),
    margin: Number(r["margin"]) || 0, secondsLeft: Number(r["seconds"]) || 0,
    call: r["playType"] ?? "", yards: Number(r["yards"]) || 0,
    touchdown: Number(r["touchdown"]) || 0,
  }));

  // time between snaps, taken where the next play is the same side in
  // the same game and the clock has moved a sensible amount
  for (let i = 0; i < plays.length - 1; i++) {
    const now = plays[i]!;
    const next = plays[i + 1]!;

    if (now.season !== next.season || now.week !== next.week) {
      continue;
    }

    if (now.offence !== next.offence) {
      continue;
    }

    const took = now.secondsLeft - next.secondsLeft;

    if (took > 0 && took <= 120) {
      now.took = took;
    }
  }

  const timed = plays.filter((p) => p.took !== undefined);
  console.log(
    `${plays.length} plays, ${timed.length} with a time between snaps\n`,
  );

  console.log("how long a play takes, in seconds\n");
  console.log("  what happened                  plays   seconds");

  const kinds: [string, (p: Play) => boolean][] = [
    ["a run that gained", (p) => p.call === "run" && p.yards > 0],
    ["a run that did not", (p) => p.call === "run" && p.yards <= 0],
    ["a throw that gained", (p) => p.call === "pass" && p.yards > 0],
    ["a throw that did not", (p) => p.call === "pass" && p.yards <= 0],
    ["a run for a first down", (p) => p.call === "run" && p.yards >= p.toGo],
    ["a throw for a first down", (p) => p.call === "pass" && p.yards >= p.toGo],
    ["inside two minutes", (p) => p.secondsLeft % 1800 < 120],
    ["two scores behind", (p) => p.margin <= -9],
    ["two scores ahead", (p) => p.margin >= 9],
  ];

  for (const [label, is] of kinds) {
    const these = timed.filter(is);

    if (these.length < 200) {
      continue;
    }

    console.log(
      "  " + label.padEnd(30) + String(these.length).padStart(6) +
        middle(these.map((p) => p.took!)).toFixed(1).padStart(10),
    );
  }

  // and what a play is, which the model does have
  console.log("\nwhat gets called, and what comes of it\n");
  console.log(
    "  situation                    plays   runs   gains nothing" +
      "   first down   touchdown",
  );

  const spots: [string, (p: Play) => boolean][] = [
    ["first and ten", (p) => p.down === 1 && p.toGo === 10],
    ["second and short", (p) => p.down === 2 && p.toGo <= 3],
    ["second and long", (p) => p.down === 2 && p.toGo >= 8],
    ["third and one", (p) => p.down === 3 && p.toGo <= 1],
    ["third and long", (p) => p.down === 3 && p.toGo >= 8],
    ["inside the ten", (p) => p.yardline <= 10],
  ];

  for (const [label, is] of spots) {
    const these = plays.filter(is);

    if (these.length < 200) {
      continue;
    }

    const runs = these.filter((p) => p.call === "run").length;
    const nothing = these.filter((p) => p.yards <= 0).length;
    const first = these.filter((p) => p.yards >= p.toGo).length;
    const scored = these.filter((p) => p.touchdown === 1).length;
    console.log(
      "  " + label.padEnd(28) + String(these.length).padStart(6) +
        `${(100 * runs / these.length).toFixed(0)}%`.padStart(7) +
        `${(100 * nothing / these.length).toFixed(1)}%`.padStart(16) +
        `${(100 * first / these.length).toFixed(1)}%`.padStart(13) +
        `${(100 * scored / these.length).toFixed(1)}%`.padStart(12),
    );
  }

  // and the gap between two snaps of the same drive, against the gap
  // across a change of possession, which are different things
  const withinDrive = timed.filter((p) => p.yards < p.toGo && p.down < 4);
  console.log(
    `\n  a snap to the next snap of the same drive: ` +
      `${middle(withinDrive.map((p) => p.took!)).toFixed(1)} seconds ` +
      `over ${withinDrive.length} of them`,
  );

  // how much a drive's time is worth knowing, since that is what
  // decides how many drives a game gets
  const perDrive = middle(timed.map((p) => p.took!)) * 5.9;
  console.log(
    `\n  an average play takes ${middle(timed.map((p) => p.took!)).toFixed(1)} seconds, ` +
      `so a drive of 5.9 plays runs about ${perDrive.toFixed(0)}\n` +
      `  and 3600 seconds at that rate leaves room for ` +
      `${(3600 / perDrive).toFixed(1)} drives, against the 22 a game really has`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
