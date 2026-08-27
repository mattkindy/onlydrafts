/**
 * What each defence does to how often a side runs and throws.
 *
 * Measured from games that were played, not from the walk. The walk
 * was the first way I did this and it understated the effect by about
 * half: it put the spread across the league at 12.5% where the box
 * scores say 26%. It also took forty minutes and this takes seconds.
 *
 * Run: npx tsx scripts/aggregateGameScript.ts [season]
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadGames, loadPlayerStats } from "../src/data/nflverse.js";
import { fitRidge } from "../src/backtest/ridge.js";

/** the season the table is for, fitted from the four before it */
const SEASON = Number(process.argv[2] ?? 2026);
const LEARN_ON = [SEASON - 4, SEASON - 3, SEASON - 2, SEASON - 1];

/**
 * How much of it to keep.
 *
 * A defence keeps 0.287 of what it does to a side's carries from one
 * season to the next, measured over 192 pairs, so most of last year's
 * is gone by August.
 */
const KEEPS = 0.287;

const games = await loadGames();
const facing = new Map<string, string>();

for (const g of games) {
  facing.set(`${g.season}|${g.homeTeamId}|${g.week}`, g.awayTeamId);
  facing.set(`${g.season}|${g.awayTeamId}|${g.week}`, g.homeTeamId);
}

const byWeek = new Map<string, { carries: number; targets: number }>();

for (const season of LEARN_ON) {
  for (const s of await loadPlayerStats(season)) {
    if (s.week > 18) {
      continue;
    }

    const key = `${season}|${s.teamId}|${s.week}`;
    const so = byWeek.get(key) ?? { carries: 0, targets: 0 };
    so.carries += s.carries;
    so.targets += s.targets;
    byWeek.set(key, so);
  }
}

const teams = [...new Set([...byWeek.keys()].map((k) => k.split("|")[1]!))].sort();
const at = new Map(teams.map((t, i) => [t, i]));

/**
 * One row per team game: who is running it and who they are playing.
 * The defence terms come out as what a fixture does once a side's own
 * habits are accounted for.
 */
function fitOver(of: (w: { carries: number; targets: number }) => number) {
  const design: number[][] = [];
  const saw: number[] = [];

  for (const [key, its] of byWeek) {
    const [season, team, week] = key.split("|");
    const against = facing.get(`${season}|${team}|${week}`);

    if (!against || !at.has(team!) || !at.has(against) || of(its) <= 0) {
      continue;
    }

    const row = new Array(1 + teams.length * 2).fill(0);
    row[0] = 1;
    row[1 + at.get(team!)!] = 1;
    row[1 + teams.length + at.get(against)!] = 1;
    design.push(row);
    saw.push(of(its));
  }

  const weights = fitRidge(design, saw, 0.5);
  const level = saw.reduce((s, v) => s + v, 0) / saw.length;
  const raw = teams.map((t) => weights[1 + teams.length + at.get(t)!] ?? 0);
  const middle = raw.reduce((s, v) => s + v, 0) / raw.length;

  // pulled back by what a defence keeps, then written as a multiple of
  // an ordinary afternoon
  return new Map(teams.map((t, i) =>
    [t, 1 + KEEPS * ((raw[i] ?? 0) - middle) / level]));
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

console.log(`fitted on ${LEARN_ON.join(", ")}, wrote ${teams.length} sides for ${SEASON}`);

const ordered = teams
  .map((t) => ({ t, v: carries.get(t) ?? 1 }))
  .sort((a, b) => a.v - b.v);

console.log("\n  you run least against, and most:");

for (const one of [...ordered.slice(0, 3), ...ordered.slice(-3)]) {
  console.log(
    `    ${one.t.padEnd(4)} carries ${one.v.toFixed(3)}, ` +
    `targets ${(targets.get(one.t) ?? 1).toFixed(3)}`,
  );
}
