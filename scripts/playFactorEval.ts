/**
 * Each factor checked on its own, before any of them are composed.
 *
 * A drive is these applied in sequence, so a drive being wrong tells
 * you nothing about which of them is. Each is asked to reproduce the
 * thing it was fitted on, at the resolution it claims to work at, and
 * then on a season it never saw.
 *
 * Run: npx tsx scripts/playFactorEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { seededRng } from "../src/sim/rng.js";
import { fitPlayFactors, type PlayRow } from "../src/features/fitPlayFactors.js";
import type { Call, PlayState } from "../src/model/playFactors.js";
import { walkDrive } from "../src/model/driveFromFactors.js";
import { fitDriveRules } from "../src/features/driveRules.js";
import { normalDraw } from "../src/sim/normal.js";

const SCORE_ON = 2025;

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

async function load(): Promise<{ learn: PlayRow[]; test: PlayRow[] }> {
  const rows = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
  )).map((r) => ({
    season: Number(r["season"]),
    down: Number(r["down"]), toGo: Number(r["togo"]),
    yardline: Number(r["yardline"]), call: (r["playType"] ?? "") as Call,
    yards: Number(r["yards"]) || 0, touchdown: Number(r["touchdown"]) || 0,
    player: r["player"] ?? "",
  }));

  return {
    learn: rows.filter((r) => r.season < SCORE_ON),
    test: rows.filter((r) => r.season === SCORE_ON),
  };
}

async function main(): Promise<void> {
  const { learn, test } = await load();
  console.log(`${learn.length} plays to fit on, ${test.length} to check against\n`);

  const factors = fitPlayFactors(learn);
  const rng = seededRng(5);

  // how often it is a run, said against what happened, at spots the
  // four bands call one thing
  console.log("how often it is a run");
  console.log("  state                          said   really   plays");

  const spots: [string, PlayState][] = [
    ["first and ten at the 75", { down: 1, toGo: 10, yardline: 75, margin: 0, secondsLeft: 1800 }],
    ["first and goal at the 2", { down: 1, toGo: 2, yardline: 2, margin: 0, secondsLeft: 1800 }],
    ["third and one at the 40", { down: 3, toGo: 1, yardline: 40, margin: 0, secondsLeft: 1800 }],
    ["third and eight at the 40", { down: 3, toGo: 8, yardline: 40, margin: 0, secondsLeft: 1800 }],
    ["third and eighteen at the 40", { down: 3, toGo: 18, yardline: 40, margin: 0, secondsLeft: 1800 }],
    ["second and goal at the 1", { down: 2, toGo: 1, yardline: 1, margin: 0, secondsLeft: 1800 }],
  ];

  for (const [label, state] of spots) {
    const near = test.filter((r) =>
      r.down === state.down &&
      Math.abs(r.toGo - state.toGo) <= 1 &&
      Math.abs(r.yardline - state.yardline) <= 2);

    if (near.length < 30) {
      continue;
    }

    console.log(
      "  " + label.padEnd(30) +
      `${(100 * factors.runs(state)).toFixed(0)}%`.padStart(6) +
      `${(100 * near.filter((r) => r.call === "run").length / near.length).toFixed(0)}%`
        .padStart(8) +
      String(near.length).padStart(8),
    );
  }

  // what a play gains from there
  console.log("\nwhat a play gains");
  console.log("  state                          said   really   plays");

  for (const [label, state] of spots) {
    const near = test.filter((r) =>
      r.down === state.down &&
      Math.abs(r.toGo - state.toGo) <= 1 &&
      Math.abs(r.yardline - state.yardline) <= 2);

    if (near.length < 30) {
      continue;
    }

    const drawn = Array.from({ length: 4000 }, () =>
      factors.gains(state, "run", "", rng));
    console.log(
      "  " + label.padEnd(30) + middle(drawn).toFixed(1).padStart(6) +
      middle(near.map((r) => r.yards)).toFixed(1).padStart(8) +
      String(near.length).padStart(8),
    );
  }

  // and how often a play from there ends in the end zone
  console.log("\nhow often it scores");
  console.log("  state                          said   really   plays");

  for (const [label, state] of spots) {
    const near = test.filter((r) =>
      r.down === state.down &&
      Math.abs(r.toGo - state.toGo) <= 1 &&
      Math.abs(r.yardline - state.yardline) <= 2);

    if (near.length < 30) {
      continue;
    }

    console.log(
      "  " + label.padEnd(30) +
      `${(100 * factors.scores(state, "run", 0)).toFixed(0)}%`.padStart(6) +
      `${(100 * middle(near.map((r) => r.touchdown))).toFixed(0)}%`.padStart(8) +
      String(near.length).padStart(8),
    );
  }

  await composed(factors, test);
}

/**
 * The factors put in sequence, with nothing fitted at the drive level.
 * If they are right, a drive should come out right by itself.
 */
async function composed(
  factors: ReturnType<typeof fitPlayFactors>,
  test: PlayRow[],
): Promise<void> {
  const rules = await fitDriveRules([2021, 2022, 2023, 2024]);
  const rng = seededRng(9);
  const normal = () => normalDraw(rng);
  const endings = new Map<string, number>();
  const lengths: number[] = [];
  let points = 0;
  const games = 3000;

  for (let game = 0; game < games; game++) {
    for (let i = 0; i < 11; i++) {
      const startAt = Math.max(35, Math.min(99, Math.round(75 + normal() * 13)));
      const drive = walkDrive(startAt, factors, rules, [""], rng);
      endings.set(drive.ending, (endings.get(drive.ending) ?? 0) + 1);
      lengths.push(drive.plays.length);
      points += drive.ending === "touchdown" ? 7
        : drive.ending === "fieldGoal" ? 3 : 0;
    }
  }

  const seen = lengths.length;
  console.log("\ndrives, with nothing about drives fitted");
  console.log("                        built   really");
  console.log(
    "  plays a drive         " + middle(lengths).toFixed(1).padStart(6) + "      5.9",
  );
  console.log(
    "  three or fewer        " +
      `${(100 * lengths.filter((n) => n <= 3).length / seen).toFixed(1)}%`.padStart(7) +
      "    33.9%",
  );
  console.log(
    "  ends in a touchdown   " +
      `${(100 * (endings.get("touchdown") ?? 0) / seen).toFixed(1)}%`.padStart(7) +
      "    23.6%",
  );
  console.log(
    "  ends in a kick        " +
      `${(100 * (endings.get("fieldGoal") ?? 0) / seen).toFixed(1)}%`.padStart(7) +
      "    14.0%",
  );
  console.log(
    "  points a team         " + (points / games).toFixed(1).padStart(6) + "     23.0",
  );

  // A drive that should have scored ended some other way, so count
  // every ending against what really happens rather than guessing
  // which factor is short.
  const reallyEnds: Record<string, number> = {
    touchdown: 23.8, fieldGoal: 15.7, punt: 35.7, turnover: 10.1,
    downs: 5.8, missedKick: 2.7, clock: 6.8,
  };
  console.log("\n  how they end          built   really");

  for (const [end, share] of Object.entries(reallyEnds)) {
    console.log(
      "    " + end.padEnd(14) +
      `${(100 * (endings.get(end) ?? 0) / seen).toFixed(1)}%`.padStart(7) +
      `${share.toFixed(1)}%`.padStart(9),
    );
  }

  // Where a drive is being lost. Too few touchdowns and too many kicks
  // says they arrive and do not finish, so count the arriving and the
  // finishing separately.
  let reached = 0;
  let finished = 0;
  let insidePlays = 0;
  let scoredAll = 0;

  for (let game = 0; game < games; game++) {
    for (let i = 0; i < 11; i++) {
      const startAt = Math.max(35, Math.min(99, Math.round(75 + normal() * 13)));
      const drive = walkDrive(startAt, factors, rules, [""], rng);
      // a snap taken inside the twenty, and nothing else. Counting
      // every scoring drive as having got there makes the conversion
      // rate come out right whatever the model does.
      const got = drive.plays.some((p) => p.state.yardline <= 20);

      if (drive.ending === "touchdown") {
        scoredAll++;
      }

      if (!got) {
        continue;
      }

      reached++;
      insidePlays += drive.plays.filter((p) => p.state.yardline <= 20).length;
      if (drive.ending === "touchdown") finished++;
    }
  }

  console.log(
    "\n  of the drives that reach the twenty" +
      `\n    ${(100 * reached / (games * 11)).toFixed(1)}% of drives get there, ` +
      "where really 31.6% do" +
      `\n    ${(100 * finished / reached).toFixed(1)}% of those score a touchdown, ` +
      "where really 57.3% do" +
      `\n    and they run ${(insidePlays / reached).toFixed(1)} plays inside it` +
      `\n    ${(100 * (1 - finished / Math.max(1, scoredAll))).toFixed(1)}% of the ` +
      "touchdowns came from outside it, where really 24% do",
  );

  // A quarter of real touchdowns are scored from outside the twenty,
  // on one long play, so the tail of what a play gains has to be right
  // or those never happen.
  const state = { down: 1, toGo: 10, yardline: 45, margin: 0, secondsLeft: 1800 };
  const drawn = Array.from({ length: 40000 }, () =>
    factors.gains(state, "run", "", rng));
  const near = test.filter((r) =>
    r.down === 1 && r.toGo === 10 && Math.abs(r.yardline - 45) <= 3);

  console.log("\n  first and ten at the 45, what a play gains");
  console.log("    gain        built   really");

  for (const [label, low] of [
    ["ten or more", 10], ["twenty or more", 20], ["forty or more", 40],
  ] as [string, number][]) {
    console.log(
      "    " + label.padEnd(14) +
      `${(100 * drawn.filter((y) => y >= low).length / drawn.length).toFixed(1)}%`
        .padStart(6) +
      `${(100 * near.filter((r) => r.yards >= low).length / near.length).toFixed(1)}%`
        .padStart(9),
    );
  }

  console.log(`    on ${near.length} plays that really happened there`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
