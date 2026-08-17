/**
 * Does learning the personnel call from the state beat cutting the
 * field into named situations?
 *
 * Fitted on 2022 to 2024 and scored on 2025, against two baselines:
 * the league's overall mix, and the mix inside each named situation,
 * which is what the model does today.
 *
 * Run: npx tsx scripts/personnelChoiceEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { situationOf } from "../src/model/situations.js";
import {
  GROUPINGS, fitPersonnel, habitOf, personnelChances,
  type Grouping, type PersonnelExample,
} from "../src/model/personnelChoice.js";

async function main(): Promise<void> {
  const rows = parseCsv(
    await readFile(join(import.meta.dirname, "..", "data", "curated", "plays.csv"), "utf8"),
  ).filter((r) => r["grouping"] && ["run", "pass"].includes(r["playType"] ?? ""));

  const asExample = (r: Record<string, string>): PersonnelExample & { season: number; offense: string } => ({
    season: Number(r["season"]),
    down: Number(r["down"]),
    toGo: Number(r["togo"]),
    yardline: Number(r["yardline"]),
    margin: Number(r["margin"]),
    seconds: Number(r["seconds"]),
    grouping: r["grouping"] as Grouping,
    offense: r["offense"] ?? "",
  });

  const all = rows.map(asExample);
  const train = all.filter((e) => e.season < 2025);
  const test = all.filter((e) => e.season === 2025);

  console.log(`${train.length} plays to learn from, ${test.length} to score on\n`);

  const model = fitPersonnel(train);
  const withTeams = fitPersonnel(train, 20, true);

  // the two baselines
  const leagueMix = {} as Record<Grouping, number>;

  for (const grouping of GROUPINGS) {
    leagueMix[grouping] = train.filter((e) => e.grouping === grouping).length / train.length;
  }

  const bySituation = new Map<string, Record<Grouping, number>>();
  const situationOfExample = (e: PersonnelExample) =>
    situationOf(e.down, e.toGo, e.yardline, -e.margin, e.seconds);

  for (const situation of new Set(train.map(situationOfExample))) {
    const inIt = train.filter((e) => situationOfExample(e) === situation);
    const mix = {} as Record<Grouping, number>;

    for (const grouping of GROUPINGS) {
      mix[grouping] = inIt.filter((e) => e.grouping === grouping).length / inIt.length;
    }

    bySituation.set(situation, mix);
  }

  /** how surprised each guess was by what actually happened */
  const surprise = (chances: (e: PersonnelExample) => Record<Grouping, number>) => {
    let total = 0;
    let right = 0;

    for (const e of test) {
      const guess = chances(e);
      total -= Math.log(Math.max(1e-6, guess[e.grouping]));
      const best = GROUPINGS.reduce((a, b) => (guess[a] >= guess[b] ? a : b));
      if (best === e.grouping) right++;
    }

    return { surprise: total / test.length, right: (right / test.length) * 100 };
  };

  // Last season only, not the three pooled. Personnel is the
  // coordinator's and does not survive him leaving, so an average over
  // three years of different men describes nobody.
  const { loadCoaches } = await import("../src/data/coaches.js");
  const coaches = await loadCoaches();
  const lastSeason = all.filter((e) => e.season === 2024);
  const habits = new Map<string, ReturnType<typeof habitOf>>();
  const keptTheCaller = new Set<string>();

  for (const team of new Set(lastSeason.map((e) => e.offense))) {
    habits.set(team, habitOf(lastSeason.filter((e) => e.offense === team)));

    if (coaches.get(`${team}|2025|OC`) === coaches.get(`${team}|2024|OC`) &&
        coaches.get(`${team}|2025|OC`)) {
      keptTheCaller.add(team);
    }
  }

  console.log(keptTheCaller.size + " offences kept their play-caller into 2025\n");

  console.log("predictor                     surprise   picks the right one");

  for (const [label, chances] of [
    ["the league's overall mix", () => leagueMix],
    ["the mix in each named situation",
      (e: PersonnelExample) => bySituation.get(situationOfExample(e)) ?? leagueMix],
    ["learned from the state", (e: PersonnelExample) => personnelChances(model, e)],
    ["the state and last year's habit",
      (e: PersonnelExample & { offense?: string }) =>
        personnelChances(model, e, habits.get(e.offense ?? ""))],
    ["the state, with the offence in the fit",
      (e: PersonnelExample) => personnelChances(withTeams, e)],
  ] as [string, (e: PersonnelExample) => Record<Grouping, number>][]) {
    const { surprise: s, right } = surprise(chances);
    console.log(label.padEnd(32) + s.toFixed(4).padStart(9) + (right.toFixed(1) + "%").padStart(16));
  }

  // what it says about places the buckets could not tell apart
  console.log("\nthird and two, by where on the field:\n");
  console.log("  from        11      12   heavy");

  for (const yardline of [2, 5, 12, 25, 50, 75]) {
    const chances = personnelChances(model, {
      down: 3, toGo: 2, yardline, margin: 0, seconds: 1800,
    });
    console.log(
      ("  the " + yardline).padEnd(12) +
      (chances["11"] * 100).toFixed(1).padStart(6) +
      (chances["12"] * 100).toFixed(1).padStart(8) +
      (chances.heavy * 100).toFixed(1).padStart(8),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
