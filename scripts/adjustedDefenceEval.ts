/**
 * A defence measured with the things that are not its doing taken out.
 *
 * Points allowed per game counts the attacks a side happened to draw,
 * how often its own offence put it back on the field, and the short
 * fields its own turnovers handed over. Measured that way a defence
 * keeps 0.200 of itself, and roster continuity makes no difference,
 * which is what a badly measured thing looks like.
 *
 * So this fits every drive at once: the attack, the defence, and where
 * the drive started. The defence term is then its own.
 *
 * Run: npx tsx scripts/adjustedDefenceEval.ts
 */

import { parseCsv } from "../src/data/csv.js";
import { fitRidge } from "../src/backtest/ridge.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SEASONS = [2022, 2023, 2024, 2025];

const rows = parseCsv(await readFile(
  join(import.meta.dirname, "..", "data", "curated", "drives.csv"), "utf8"));

interface Drive {
  season: number;
  offense: string;
  defence: string;
  startYard: number;
  points: number;
}

const drives: Drive[] = [];

for (const r of rows) {
  const season = Number(r["season"]);
  const startYard = Number(r["startYard"]);
  const points = Number(r["points"]);

  if (!SEASONS.includes(season) || !Number.isFinite(startYard) ||
      !Number.isFinite(points)) {
    continue;
  }

  drives.push({
    season, offense: r["offense"] ?? "", defence: r["defense"] ?? "",
    startYard, points,
  });
}

const teams = [...new Set(drives.flatMap((d) => [d.offense, d.defence]))].sort();
const at = new Map(teams.map((t, i) => [t, i]));

/**
 * One row per drive: an intercept, a column for the attack, a column
 * for the defence, and where it started. Ridge sorts out that the two
 * sets of columns together repeat the intercept.
 */
function rowFor(d: Drive): number[] {
  const out = new Array(3 + teams.length * 2).fill(0);
  out[0] = 1;
  out[1 + at.get(d.offense)!] = 1;
  out[1 + teams.length + at.get(d.defence)!] = 1;
  out[1 + teams.length * 2] = (d.startYard - 75) / 25;
  out[2 + teams.length * 2] = ((d.startYard - 75) / 25) ** 2;

  return out;
}

/** what each defence is worth in points a drive, once the rest is out */
function defenceIn(season: number): Map<string, number> {
  const its = drives.filter((d) => d.season === season);
  const weights = fitRidge(its.map(rowFor), its.map((d) => d.points), 1.0);
  const start = 1 + teams.length;
  const all = teams.map((t) => weights[start + at.get(t)!] ?? 0);
  const mean = all.reduce((s, v) => s + v, 0) / all.length;

  // under nought is a good defence
  return new Map(teams.map((team, i) => [team, (all[i] ?? 0) - mean]));
}

/** and the plain version, for holding the two against each other */
function rawIn(season: number): Map<string, number> {
  const allowed = new Map<string, { points: number; drives: number }>();

  for (const d of drives) {
    if (d.season !== season) {
      continue;
    }

    const so = allowed.get(d.defence) ?? { points: 0, drives: 0 };
    so.points += d.points;
    so.drives++;
    allowed.set(d.defence, so);
  }

  const per = new Map([...allowed].map(([t, a]) => [t, a.points / a.drives]));
  const mean = [...per.values()].reduce((s, v) => s + v, 0) / per.size;

  return new Map([...per].map(([t, v]) => [t, v - mean]));
}

function slope(pairs: [number, number][]): { slope: number; n: number } {
  const n = pairs.length;
  const mx = pairs.reduce((s, [x]) => s + x, 0) / n;
  const my = pairs.reduce((s, [, y]) => s + y, 0) / n;
  let top = 0;
  let bottom = 0;

  for (const [x, y] of pairs) {
    top += (x - mx) * (y - my);
    bottom += (x - mx) ** 2;
  }

  return { slope: bottom > 0 ? top / bottom : 0, n };
}

const adjusted = new Map(SEASONS.map((s) => [s, defenceIn(s)]));
const plain = new Map(SEASONS.map((s) => [s, rawIn(s)]));

console.log("How much of a defence is still there next season,");
console.log("measured plainly and with the rest taken out.\n");

for (const [name, table] of [
  ["points a drive, as it stands", plain],
  ["the same, attack and field position out", adjusted],
] as [string, Map<number, Map<string, number>>][]) {
  const pairs: [number, number][] = [];

  for (let i = 1; i < SEASONS.length; i++) {
    const before = table.get(SEASONS[i - 1]!)!;
    const after = table.get(SEASONS[i]!)!;

    for (const [team, was] of before) {
      const now = after.get(team);

      if (now !== undefined) {
        pairs.push([was, now]);
      }
    }
  }

  const its = slope(pairs);
  console.log(`  ${name.padEnd(40)} ${its.slope.toFixed(3)}   (${its.n} pairs)`);
}

console.log("\nPressure and how they line up, which are counted on every");
console.log("dropback rather than only when something happened.\n");

const pressureRows = parseCsv(await readFile(
  join(import.meta.dirname, "..", "data", "curated", "pressureMatchups.csv"), "utf8"));

const DENSE: [string, (r: Record<string, string>) => number, (r: Record<string, string>) => number][] = [
  ["pressure a dropback", (r) => Number(r["pressures"]), (r) => Number(r["dropbacks"])],
  ["men rushing", (r) => Number(r["rushers"]) * Number(r["dropbacks"]), (r) => Number(r["dropbacks"])],
  ["men in the box", (r) => Number(r["box"]) * Number(r["dropbacks"]), (r) => Number(r["dropbacks"])],
];

for (const [name, top, bottom] of DENSE) {
  const bySeason = new Map<number, Map<string, { top: number; bottom: number }>>();

  for (const r of pressureRows) {
    const season = Number(r["season"]);
    const t = top(r);
    const b = bottom(r);

    if (!Number.isFinite(t) || !Number.isFinite(b) || b <= 0) {
      continue;
    }

    const table = bySeason.get(season) ?? new Map();
    const so = table.get(r["defense"] ?? "") ?? { top: 0, bottom: 0 };
    so.top += t;
    so.bottom += b;
    table.set(r["defense"] ?? "", so);
    bySeason.set(season, table);
  }

  const rate = new Map<number, Map<string, number>>();

  for (const [season, table] of bySeason) {
    const per = new Map([...table].map(([t, a]) => [t, a.top / a.bottom]));
    const mean = [...per.values()].reduce((s, v) => s + v, 0) / per.size;
    rate.set(season, new Map([...per].map(([t, v]) => [t, v - mean])));
  }

  const seasons = [...rate.keys()].sort();
  const pairs: [number, number][] = [];

  for (let i = 1; i < seasons.length; i++) {
    const before = rate.get(seasons[i - 1]!)!;
    const after = rate.get(seasons[i]!)!;

    for (const [team, was] of before) {
      const now = after.get(team);

      if (now !== undefined) {
        pairs.push([was, now]);
      }
    }
  }

  const its = slope(pairs);
  console.log(`  ${name.padEnd(40)} ${its.slope.toFixed(3)}   (${its.n} pairs)`);
}
