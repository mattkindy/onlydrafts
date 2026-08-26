/**
 * Walks a season and writes down what each defence does to a side's
 * volume, for the weekly view to read.
 *
 * The walk itself is slow and its weeks are noisy, so this runs once
 * and keeps the part that settles: the opponent term pooled over every
 * fixture a side played.
 *
 * Run: npx tsx scripts/aggregateGameScript.ts [season]
 */

import { writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildWorld } from "../src/features/playedWorld.js";
import { walkSeason, type Fixture } from "../src/features/walkedSeason.js";
import { fitClimate } from "../src/features/climate.js";
import { readingsFrom, kickoffsIn } from "../src/data/gameWeather.js";
import { parseCsv } from "../src/data/csv.js";
import { loadPlayerStats, loadWeeklyRosters } from "../src/data/nflverse.js";
import { seededRng } from "../src/sim/rng.js";
import { fitRidge } from "../src/backtest/ridge.js";

const SEASON = Number(process.argv[2] ?? 2026);
const RUNS = Number(process.env["RUNS"] ?? 60);

const positions = new Map<string, string>();

for (const s of await loadPlayerStats(SEASON - 1)) {
  positions.set(s.playerId, s.position);
}

/** where each man is in the season being walked, not the one before */
const teamOf = new Map<string, string>();

for (const man of await loadWeeklyRosters(SEASON)) {
  if (man.week === 1) {
    teamOf.set(man.playerId, man.teamId);
  }
}

console.log(`building the world as it looks before ${SEASON}...`);
const world = await buildWorld(SEASON, 1, false, positions);

const rows = parseCsv(await readFile(
  join(import.meta.dirname, "..", "data", "raw", "games.csv"), "utf8"));
const climate = fitClimate(readingsFrom(rows));
const fixtures: Fixture[] = kickoffsIn(rows, SEASON).map((k) => ({
  week: k.week, homeTeam: k.homeTeam, awayTeam: k.awayTeam,
  hour: k.hour, indoors: k.indoors,
  homeRest: k.homeRest, awayRest: k.awayRest,
}));

console.log(`playing ${fixtures.length} fixtures ${RUNS} times over...`);
const walked = walkSeason(
  world, fixtures, { runs: RUNS, gamesFor: () => 17, climate }, seededRng(31),
);

const teamWeeks = new Map<string, Map<number, { carries: number; targets: number }>>();

for (const [playerId, lines] of walked) {
  const team = teamOf.get(playerId);

  if (!team) {
    continue;
  }

  const its = teamWeeks.get(team) ?? new Map<number, { carries: number; targets: number }>();

  for (const week of lines.byWeek) {
    const so = its.get(week.week) ?? { carries: 0, targets: 0 };
    so.carries += week.parts.carries;
    so.targets += week.parts.targets;
    its.set(week.week, so);
  }

  teamWeeks.set(team, its);
}

const teams = [...teamWeeks.keys()].sort();
const at = new Map(teams.map((t, i) => [t, i]));

/**
 * One row per team game: who is running it, and who they are playing.
 * The defence terms come out as what a fixture does once the side's own
 * habits are accounted for.
 */
function fitOver(of: (w: { carries: number; targets: number }) => number) {
  const design: number[][] = [];
  const saw: number[] = [];

  for (const f of fixtures) {
    for (const [team, against] of [
      [f.homeTeam, f.awayTeam], [f.awayTeam, f.homeTeam],
    ] as [string, string][]) {
      const its = teamWeeks.get(team)?.get(f.week);

      if (!its || !at.has(team) || !at.has(against) || of(its) <= 0) {
        continue;
      }

      const row = new Array(1 + teams.length * 2).fill(0);
      row[0] = 1;
      row[1 + at.get(team)!] = 1;
      row[1 + teams.length + at.get(against)!] = 1;
      design.push(row);
      saw.push(of(its));
    }
  }

  const weights = fitRidge(design, saw, 0.5);
  const level = saw.reduce((s, v) => s + v, 0) / saw.length;
  const raw = teams.map((t) => weights[1 + teams.length + at.get(t)!] ?? 0);
  const middle = raw.reduce((s, v) => s + v, 0) / raw.length;

  // as a multiple of an ordinary afternoon, which is what the weekly
  // view wants to multiply by
  return new Map(teams.map((t, i) => [t, 1 + ((raw[i] ?? 0) - middle) / level]));
}

const carries = fitOver((w) => w.carries);
const targets = fitOver((w) => w.targets);

const out = ["season,defence,carries,targets"];

for (const team of teams) {
  out.push([
    SEASON, team,
    (carries.get(team) ?? 1).toFixed(4),
    (targets.get(team) ?? 1).toFixed(4),
  ].join(","));
}

const path = join(import.meta.dirname, "..", "data", "curated", "gameScript.csv");
await writeFile(path, out.join("\n") + "\n", "utf8");

console.log(`\nwrote ${teams.length} sides to data/curated/gameScript.csv\n`);

const ordered = teams
  .map((t) => ({ t, v: carries.get(t) ?? 1 }))
  .sort((a, b) => a.v - b.v);

console.log("  you run least against, and most:");

for (const one of [...ordered.slice(0, 3), ...ordered.slice(-3)]) {
  console.log(
    `    ${one.t.padEnd(4)} carries ${one.v.toFixed(3)}, ` +
    `targets ${(targets.get(one.t) ?? 1).toFixed(3)}`,
  );
}
