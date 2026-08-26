/**
 * Does the walk turn a hard fixture into fewer carries?
 *
 * A back's share of his side's carries barely moves. The number of
 * carries there are to take does: chase a good team and you throw,
 * lead a bad one and you run the clock out. The weekly model works on
 * a man's points and has no way to say that. The walk tracks the score
 * and picks its calls off it, so it should fall out on its own.
 *
 * Run: npx tsx scripts/gameScriptEval.ts [season]
 */

import { buildWorld } from "../src/features/playedWorld.js";
import { walkSeason, type Fixture } from "../src/features/walkedSeason.js";
import { fitClimate } from "../src/features/climate.js";
import { readingsFrom, kickoffsIn } from "../src/data/gameWeather.js";
import { parseCsv } from "../src/data/csv.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { seededRng } from "../src/sim/rng.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SEASON = Number(process.argv[2] ?? 2024);
const RUNS = Number(process.env["RUNS"] ?? 12);

const positions = new Map<string, string>();
const teamOf = new Map<string, string>();

for (const s of await loadPlayerStats(SEASON - 1)) {
  positions.set(s.playerId, s.position);
}

for (const s of await loadPlayerStats(SEASON)) {
  if (s.week === 1) {
    teamOf.set(s.playerId, s.teamId);
  }
}

console.log(`building the world as it looked before ${SEASON}...`);
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

/** what each side ran and threw in each week, added over its men */
const teamWeeks = new Map<string, Map<number, { carries: number; targets: number }>>();

for (const [playerId, lines] of walked) {
  const team = teamOf.get(playerId);

  if (!team) {
    continue;
  }

  const its = teamWeeks.get(team) ?? new Map();

  for (const week of lines.byWeek) {
    const so = its.get(week.week) ?? { carries: 0, targets: 0 };
    so.carries += week.parts.carries;
    so.targets += week.parts.targets;
    its.set(week.week, so);
  }

  teamWeeks.set(team, its);
}

console.log("\nHow much a side's carries move from week to week in the walk,");
console.log("as the most it ran over the least it ran.\n");

const swings: { team: string; swing: number; lean: number }[] = [];

for (const [team, weeks] of teamWeeks) {
  const carries = [...weeks.values()].map((w) => w.carries).filter((c) => c > 0);
  const runShare = [...weeks.values()]
    .filter((w) => w.carries + w.targets > 0)
    .map((w) => w.carries / (w.carries + w.targets));

  if (carries.length < 10) {
    continue;
  }

  swings.push({
    team,
    swing: Math.max(...carries) / Math.min(...carries),
    lean: Math.max(...runShare) - Math.min(...runShare),
  });
}

swings.sort((a, b) => b.swing - a.swing);
const middle = swings[swings.length >> 1]!;

console.log(`  over ${swings.length} sides, the middle one swings ${middle.swing.toFixed(2)}`);
console.log(`  and its run share moves ${(100 * middle.lean).toFixed(1)} points across the season\n`);
console.log("  the widest and the narrowest:");

for (const s of [...swings.slice(0, 3), ...swings.slice(-3)]) {
  console.log(
    `    ${s.team.padEnd(4)} carries ${s.swing.toFixed(2)} times over, ` +
    `run share moves ${(100 * s.lean).toFixed(1)} points`,
  );
}

/**
 * The question underneath: is any of it the opponent, or is it the
 * dice? Comparing the two meetings of a pair uses a fraction of what
 * was played and leaves the answer inside the sampling. Fitting every
 * fixture at once asks the same thing with all of it.
 */
const teams = [...teamWeeks.keys()].sort();
const at = new Map(teams.map((t, i) => [t, i]));
const design: number[][] = [];
const ran: number[] = [];

for (const f of fixtures) {
  for (const [team, against] of [
    [f.homeTeam, f.awayTeam], [f.awayTeam, f.homeTeam],
  ] as [string, string][]) {
    const its = teamWeeks.get(team)?.get(f.week);

    if (!its || its.carries <= 0 || !at.has(team) || !at.has(against)) {
      continue;
    }

    const row = new Array(1 + teams.length * 2).fill(0);
    row[0] = 1;
    row[1 + at.get(team)!] = 1;
    row[1 + teams.length + at.get(against)!] = 1;
    design.push(row);
    ran.push(its.carries);
  }
}

const weights = fitRidge(design, ran, 0.5);
const said = design.map((r) => predictRidge(weights, r));
const middleRan = ran.reduce((s, v) => s + v, 0) / ran.length;
const total = ran.reduce((s, v) => s + (v - middleRan) ** 2, 0);
const left = ran.reduce((s, v, i) => s + (v - said[i]!) ** 2, 0);

/** the same fit with nothing but who is carrying it */
const ownOnly = design.map((r) => r.slice(0, 1 + teams.length));
const ownWeights = fitRidge(ownOnly, ran, 0.5);
const ownSaid = ownOnly.map((r) => predictRidge(ownWeights, r));
const ownLeft = ran.reduce((s, v, i) => s + (v - ownSaid[i]!) ** 2, 0);

console.log("\nFitting every fixture at once, to ask what moves a side's carries:\n");
console.log(`  who is carrying it explains        ${(1 - ownLeft / total).toFixed(3)}`);
console.log(`  and who they are playing as well   ${(1 - left / total).toFixed(3)}`);
console.log(`  so the opponent is worth           ${((ownLeft - left) / total).toFixed(3)}`);

const defence = teams.map((t) => weights[1 + teams.length + at.get(t)!] ?? 0);
const level = defence.reduce((s, v) => s + v, 0) / defence.length;
const ordered = teams
  .map((t, i) => ({ t, v: (defence[i] ?? 0) - level }))
  .sort((a, b) => a.v - b.v);

console.log("\n  sides you run least against, and most:");
for (const one of [...ordered.slice(0, 3), ...ordered.slice(-3)]) {
  console.log(`    ${one.t.padEnd(4)} ${one.v >= 0 ? "+" : ""}${one.v.toFixed(2)} carries`);
}
