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
import {
  fitFourthDown, climbTo, type FourthRow,
} from "../src/features/fitFourthDown.js";
import { loadDriveStarts, startFrom } from "../src/features/driveStarts.js";
import { fitEndings } from "../src/features/fitEndings.js";
import { fitTurnovers, type TurnoverRow } from "../src/features/fitTurnovers.js";
import { fitDriveRules } from "../src/features/driveRules.js";

/** the fourth downs where a side actually chose, so not the flags */
const DECIDED = ["run", "pass", "field_goal", "punt"];

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
    offence: r["offense"] ?? "", defence: r["defense"] ?? "",
    margin: Number(r["margin"]) || 0, secondsLeft: Number(r["seconds"]) || 1800,
    yards: Number(r["yards"]) || 0, touchdown: Number(r["touchdown"]) || 0,
    player: r["player"] ?? "",
  }));

  return {
    learn: rows.filter((r) => r.season < SCORE_ON),
    test: rows.filter((r) => r.season === SCORE_ON),
  };
}


/** what sides really did on fourth down, before the season being tested */
async function fourthDowns(before: number) {
  const rows = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "plays.csv"), "utf8",
  )).filter((r) =>
    Number(r["season"]) < before && Number(r["down"]) === 4 &&
    DECIDED.includes(r["playType"] ?? ""));

  // lifted to where the season being asked about sits on the climb,
  // using only the seasons fitted on
  const seasons = [...new Set(rows.map((r) => Number(r["season"])))];

  return fitFourthDown(
    rows.map((r) => ({
      toGo: Number(r["togo"]), yardline: Number(r["yardline"]),
      margin: Number(r["margin"]) || 0, secondsLeft: Number(r["seconds"]) || 1800,
      choice: ["run", "pass"].includes(r["playType"] ?? "") ? "go"
        : r["playType"] === "field_goal" ? "kick" : "punt",
    })) as FourthRow[],
    60, 6, 1,
    Number(process.env["LIFT"] ?? 0) || climbTo(seasons, before),
  );
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

  /**
   * Asked of the same plays the model is asked about.
   *
   * Taking every play within a couple of yards of the spot and calling
   * that what really happens averages the neighbours in, which pulls
   * the answer toward the middle and makes the model look more extreme
   * than it is. The model is asked about each play's own state instead,
   * and the two are compared over the same set.
   */
  for (const [label, state] of spots) {
    const near = test.filter((r) =>
      r.down === state.down &&
      Math.abs(r.toGo - state.toGo) <= 1 &&
      Math.abs(r.yardline - state.yardline) <= 2);

    if (near.length < 30) {
      continue;
    }

    const said = middle(near.map((r) => factors.runs({
      down: r.down, toGo: r.toGo, yardline: r.yardline,
      margin: r.margin, secondsLeft: r.secondsLeft,
    })));

    console.log(
      "  " + label.padEnd(30) +
      `${(100 * said).toFixed(0)}%`.padStart(6) +
      `${(100 * near.filter((r) => r.call === "run").length / near.length).toFixed(0)}%`
        .padStart(8) +
      String(near.length).padStart(8),
    );
  }

  // the same spot on the field under a different clock and score, to
  // show the call moving with them rather than only with the down
  console.log("\nfirst and ten at the 40, as the game changes");
  console.log("  when                              runs   really   plays");

  const clocks: [string, number, number][] = [
    ["early, level", 2400, 0],
    ["late, three behind", 240, -3],
    ["late, seven behind", 240, -7],
    ["late, a score ahead", 240, 7],
    ["late, two scores behind", 240, -14],
  ];

  for (const [label, secondsLeft, margin] of clocks) {
    const state = { down: 1, toGo: 10, yardline: 40, margin, secondsLeft };
    const near = test.filter((r) =>
      r.down === 1 && Math.abs(r.toGo - 10) <= 1 &&
      Math.abs(r.yardline - 40) <= 6 &&
      Math.abs(r.secondsLeft - secondsLeft) <= 400 &&
      Math.abs(r.margin - margin) <= 2);

    console.log(
      "  " + label.padEnd(32) +
      `${(100 * factors.runs(state)).toFixed(0)}%`.padStart(6) +
      (near.length >= 25
        ? `${(100 * near.filter((r) => r.call === "run").length / near.length).toFixed(0)}%`
          .padStart(9)
        : "       -") +
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
  const fourth = await fourthDowns(SCORE_ON);
  const fourths = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "plays.csv"), "utf8",
  )).filter((r) => Number(r["season"]) === SCORE_ON && Number(r["down"]) === 4)
    .map((r) => ({
      toGo: Number(r["togo"]), yardline: Number(r["yardline"]),
      choice: ["run", "pass"].includes(r["playType"] ?? "") ? "go" : "other",
    }));
  const starts = await loadDriveStarts([2022, 2023, 2024]);
  // the kick and the clock, off the plays rather than written down
  const kicking = await fitEndings([2021, 2022, 2023, 2024]);
  const turnovers = fitTurnovers(parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "endings.csv"), "utf8",
  )).filter((r) => r["kind"] === "play" && Number(r["season"]) < SCORE_ON)
    .map((r) => ({
      down: Number(r["down"]), toGo: Number(r["togo"]),
      yardline: Number(r["yardline"]), margin: 0, secondsLeft: 1800,
      call: r["call"] as "run" | "pass", lost: Number(r["made"]) || 0,
    })) as TurnoverRow[]);
  const withEndings = {
    ...rules, kickSucceeds: kicking.kickSucceeds,
    turnoverAt: (state: PlayState, call: Call) => turnovers.rate(state, call),
  };
  const clock = { isLast: kicking.isLast, lastLength: kicking.lastLength };
  // Over several starts, because changing anything shifts the whole
  // stream of draws and a single run moves by more than most of the
  // things being measured.
  const endings = new Map<string, number>();
  const lengths: number[] = [];
  const perSeed: number[] = [];
  const games = 1200;
  const seeds = [9, 19, 29, 39, 59];

  for (const seed of seeds) {
    const rng = seededRng(seed);
    let points = 0;

    for (let game = 0; game < games; game++) {
      for (let i = 0; i < 11; i++) {
        const startAt = startFrom(starts, rng);
        const drive = walkDrive(startAt, factors, withEndings, fourth, [""], rng, clock);
        endings.set(drive.ending, (endings.get(drive.ending) ?? 0) + 1);
        lengths.push(drive.plays.length);
        points += drive.ending === "touchdown" ? 7
          : drive.ending === "fieldGoal" ? 3 : 0;
      }
    }

    perSeed.push(points / games);
  }

  const rng = seededRng(9);
  const points = perSeed.reduce((a, b) => a + b, 0) / perSeed.length * games;

  const seen = lengths.length;
  void points;
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
  const spread = Math.sqrt(
    perSeed.reduce((a, b) => a + (b - middle(perSeed)) ** 2, 0) / perSeed.length,
  );
  console.log(
    "  points a team         " + middle(perSeed).toFixed(1).padStart(6) + "     23.0" +
    `   (moves ${spread.toFixed(2)} between starts)`,
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
  const faced: number[] = [];
  let reached = 0;
  let finished = 0;
  let insidePlays = 0;
  let scoredAll = 0;

  for (let game = 0; game < games; game++) {
    for (let i = 0; i < 11; i++) {
      const startAt = startFrom(starts, rng);
      const drive = walkDrive(startAt, factors, withEndings, fourth, [""], rng, clock);
      // a snap taken inside the twenty, and nothing else. Counting
      // every scoring drive as having got there makes the conversion
      // rate come out right whatever the model does.
      const got = drive.plays.some((p) => p.state.yardline <= 20);

      // recorded before the guard below, which drops every drive that
      // never reached the twenty
      for (const spot of drive.facedAt) {
        faced.push(spot);
      }

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

  const sortedFaced = [...faced].sort((a, b) => a - b);
  const middleOf = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
  console.log(
    "\n  where it stands when it faces fourth down\n" +
      `    average ${middleOf(faced).toFixed(1)} out where sides average 47.3,\n` +
      `    half inside ${sortedFaced[Math.floor(sortedFaced.length / 2)]} where sides are inside 50,\n` +
      `    ${(100 * faced.filter((y) => y <= 40).length / Math.max(1, faced.length)).toFixed(1)}% ` +
      "inside the forty where 38.8% of theirs are",
  );

  console.log("\n  fourth down, what a side does");
  console.log("    state                    go   kick   punt   really go");

  for (const [label, toGo, yardline] of [
    ["and goal at the 2", 2, 2],
    ["and goal at the 5", 5, 5],
    ["and three at the 8", 3, 8],
    ["and one at the 15", 1, 15],
    ["and five at the 30", 5, 30],
    ["and one at the 55", 1, 55],
  ] as [string, number, number][]) {
    const state = { down: 4, toGo, yardline, margin: 0, secondsLeft: 1800 };
    const odds = fourth.chances(state);
    const near = fourths.filter((r) =>
      Math.abs(r.toGo - toGo) <= 1 && Math.abs(r.yardline - yardline) <= 3);
    console.log(
      "    " + label.padEnd(24) +
      `${(100 * odds.go).toFixed(0)}%`.padStart(5) +
      `${(100 * odds.kick).toFixed(0)}%`.padStart(7) +
      `${(100 * odds.punt).toFixed(0)}%`.padStart(7) +
      (near.length >= 20
        ? `${(100 * near.filter((r) => r.choice === "go").length / near.length).toFixed(0)}%`
          .padStart(11)
        : "          -"),
    );
  }

  /**
   * Whether a set of downs gets converted, which is what turns a drive
   * into a score. Everything below it checks out, so if drives stall
   * more than they should this is where it happens.
   */
  console.log("\n  moving the chains");
  console.log("    down    built   really   plays");

  for (const down of [1, 2, 3]) {
    const near = test.filter((r) => r.down === down && r.toGo >= 1 && r.toGo <= 20);

    if (near.length < 200) {
      continue;
    }

    let got = 0;
    const tries = 20000;

    for (let i = 0; i < tries; i++) {
      const from = near[Math.floor(rng() * near.length)]!;
      const state = {
        down, toGo: from.toGo, yardline: from.yardline,
        margin: from.margin, secondsLeft: from.secondsLeft,
      };
      const call = rng() < factors.runs(state) ? "run" as const : "pass" as const;
      const gained = factors.gains(state, call, "", rng);
      if (gained >= from.toGo) got++;
    }

    console.log(
      "    " + String(down).padEnd(8) +
      `${(100 * got / tries).toFixed(1)}%`.padStart(6) +
      `${(100 * near.filter((r) => r.yards >= r.toGo).length / near.length).toFixed(1)}%`
        .padStart(9) +
      String(near.length).padStart(8),
    );
  }

  /**
   * Scoring from distance on one play, which is a quarter of all
   * touchdowns and almost none of ours. A play only reaches the end
   * zone here if what it gains covers the whole distance, so this is a
   * question about the far tail at each spot.
   */
  console.log("\n  scoring from here on one play");
  console.log("    from the      built   really   plays");

  for (const yardline of [25, 35, 45, 60, 75]) {
    const near = test.filter((r) => Math.abs(r.yardline - yardline) <= 4);

    if (near.length < 200) {
      continue;
    }

    let got = 0;
    const tries = 40000;

    for (let i = 0; i < tries; i++) {
      const from = near[Math.floor(rng() * near.length)]!;
      const state = {
        down: from.down, toGo: from.toGo, yardline: from.yardline,
        margin: from.margin, secondsLeft: from.secondsLeft,
      };
      const call = rng() < factors.runs(state) ? "run" as const : "pass" as const;
      if (factors.gains(state, call, "", rng) >= from.yardline) got++;
    }

    console.log(
      "    " + yardline.toString().padEnd(14) +
      `${(100 * got / tries).toFixed(2)}%`.padStart(6) +
      `${(100 * near.filter((r) => r.touchdown === 1).length / near.length).toFixed(2)}%`
        .padStart(9) +
      String(near.length).padStart(8),
    );
  }

  // the whole far tail at one spot, to see where ours stops
  {
    const state = { down: 1, toGo: 10, yardline: 45, margin: 0, secondsLeft: 1800 };
    const drawn = Array.from({ length: 60000 }, () =>
      factors.gains(state, "run", "", rng));
    const near = test.filter((r) =>
      r.down === 1 && Math.abs(r.toGo - 10) <= 1 && Math.abs(r.yardline - 45) <= 3);

    console.log("\n  first and ten at the 45, the far tail");
    console.log("    gain      built   really");

    for (const low of [20, 30, 40, 45, 50, 60]) {
      console.log(
        "    " + `${low}+`.padEnd(10) +
        `${(100 * drawn.filter((y) => y >= low).length / drawn.length).toFixed(2)}%`
          .padStart(6) +
        `${(100 * near.filter((r) => r.yards >= low).length / near.length).toFixed(2)}%`
          .padStart(9),
      );
    }

    console.log(
      `    longest built ${Math.max(...drawn)}, longest really ` +
        `${Math.max(...near.map((r) => r.yards))}, on ${near.length} plays`,
    );
  }

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
