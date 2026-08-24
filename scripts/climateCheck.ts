/**
 * What the climate model says about grounds we know the weather at.
 * Run: npx tsx scripts/climateCheck.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { fitClimate, type Reading } from "../src/features/climate.js";
import { seededRng } from "../src/sim/rng.js";

const rows = parseCsv(await readFile(
  join(import.meta.dirname, "..", "data", "raw", "games.csv"), "utf8"));
const readings: Reading[] = [];

for (const r of rows) {
  const roof = r["roof"] ?? "";

  if (r["game_type"] !== "REG" || (roof !== "outdoors" && roof !== "open")) {
    continue;
  }

  const temperature = Number(r["temp"]);
  const hour = Number((r["gametime"] ?? "").split(":")[0]);

  // 430 games are recorded as exactly zero, three of them in Miami in
  // December, so a nought means nobody wrote the temperature down
  if (!Number.isFinite(temperature) || temperature === 0 ||
      r["temp"] === "NA" || !Number.isFinite(hour)) {
    continue;
  }

  readings.push({
    team: r["home_team"] ?? "", week: Number(r["week"]), hour, temperature,
    wind: r["wind"] && r["wind"] !== "NA" ? Number(r["wind"]) : undefined,
  });
}

console.log(`${readings.length} outdoor readings\n`);
const climate = fitClimate(readings);

// how far off it lands on readings it never saw: fit on all but one year
const held = readings.filter((_, i) => i % 5 === 0);
const rest = readings.filter((_, i) => i % 5 !== 0);
const tried = fitClimate(rest);
const off = held.map((r) =>
  Math.abs(tried.meanTemperature(r.team, r.week, r.hour) - r.temperature));
console.log("held out one reading in five: off by " +
  (off.reduce((a, b) => a + b, 0) / off.length).toFixed(1) + " degrees on average");
const flat = held.map((r) => Math.abs(60 - r.temperature));
console.log("calling every day sixty:      off by " +
  (flat.reduce((a, b) => a + b, 0) / flat.length).toFixed(1) + " degrees\n");

console.log("what it says, one o'clock kickoff");
console.log("  ground   week 1   week 9   week 17   a cold week 17");
const rng = seededRng(3);

for (const team of ["MIA", "TB", "JAX", "KC", "PIT", "CHI", "NE", "BUF", "GB", "DEN"]) {
  const draws = Array.from({ length: 2000 }, () => climate.drawTemperature(team, 17, 13, rng))
    .sort((a, b) => a - b);
  console.log("  " + team.padEnd(8) +
    climate.meanTemperature(team, 1, 13).toFixed(0).padStart(6) +
    climate.meanTemperature(team, 9, 13).toFixed(0).padStart(9) +
    climate.meanTemperature(team, 17, 13).toFixed(0).padStart(10) +
    ("  " + draws[Math.floor(0.1 * draws.length)]!.toFixed(0) + " to " +
      draws[Math.floor(0.9 * draws.length)]!.toFixed(0)).padStart(16));
}

console.log("\n  and the same ground at one o'clock against at night, week 17");
for (const team of ["GB", "BUF", "MIA"]) {
  console.log("  " + team.padEnd(8) +
    "day " + climate.meanTemperature(team, 17, 13).toFixed(0) +
    "   night " + climate.meanTemperature(team, 17, 20).toFixed(0));
}
