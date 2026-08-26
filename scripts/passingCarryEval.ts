/**
 * Which parts of a throw last, the way the carrying and catching ones
 * were measured.
 *
 * A receiver keeps 0.878 of how far the ball travels to him and 0.176
 * of his drops. If a passer splits the same way, the joint model can
 * see a quarterback and the regression has nothing left to do.
 *
 * Run: npx tsx scripts/passingCarryEval.ts
 */

import { parseCsv } from "../src/data/csv.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SEASONS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
const ENOUGH = 150;

type Row = Record<string, string>;
const n = (r: Row, key: string) => Number(r[key]);

const rows = parseCsv(await readFile(
  join(import.meta.dirname, "..", "data", "raw", "advstats_pass.csv"), "utf8"));

const bySeason = new Map<number, Map<string, Row>>();

for (const r of rows) {
  const season = Number(r["season"]);

  if (!SEASONS.includes(season) || n(r, "pass_attempts") < ENOUGH) {
    continue;
  }

  const table = bySeason.get(season) ?? new Map<string, Row>();
  table.set(r["pfr_id"] ?? "", r);
  bySeason.set(season, table);
}

const WAYS: [string, (r: Row) => number][] = [
  ["throws a season", (r) => n(r, "pass_attempts")],
  ["  how deep he means it", (r) => n(r, "intended_air_yards_per_pass_attempt")],
  ["  how deep it lands", (r) => n(r, "completed_air_yards_per_completion")],
  ["  after the catch", (r) => n(r, "pass_yards_after_catch_per_completion")],
  ["on target", (r) => n(r, "on_tgt_pct")],
  ["a bad throw", (r) => n(r, "bad_throw_pct")],
  ["thrown away", (r) => n(r, "throwaways") / n(r, "pass_attempts")],
  ["dropped on him", (r) => n(r, "drop_pct")],
  ["time in the pocket", (r) => n(r, "pocket_time")],
  ["pressured", (r) => n(r, "pressure_pct")],
  ["scrambles a throw", (r) => n(r, "scrambles") / n(r, "pass_attempts")],
];

function slope(pairs: [number, number][]): { slope: number; n: number } {
  const count = pairs.length;

  if (count < 25) {
    return { slope: NaN, n: count };
  }

  const mx = pairs.reduce((s, [x]) => s + x, 0) / count;
  const my = pairs.reduce((s, [, y]) => s + y, 0) / count;
  let top = 0;
  let bottom = 0;

  for (const [x, y] of pairs) {
    top += (x - mx) * (y - my);
    bottom += (x - mx) ** 2;
  }

  return { slope: bottom > 0 ? top / bottom : 0, n: count };
}

console.log("How much of a passer is there next season, part by part.");
console.log("A receiver keeps 0.878 of his depth and 0.176 of his drops.\n");

for (const [name, of] of WAYS) {
  const pairs: [number, number][] = [];

  for (let i = 1; i < SEASONS.length; i++) {
    const before = bySeason.get(SEASONS[i - 1]!);
    const after = bySeason.get(SEASONS[i]!);

    if (!before || !after) {
      continue;
    }

    const levelOf = (t: Map<string, Row>) => {
      const all = [...t.values()].map(of).filter(Number.isFinite);

      return all.reduce((s, v) => s + v, 0) / Math.max(1, all.length);
    };
    const was = levelOf(before);
    const now = levelOf(after);

    for (const [who, r] of before) {
      const next = after.get(who);

      if (!next || was === 0 || now === 0) {
        continue;
      }

      const a = of(r);
      const b = of(next);

      if (Number.isFinite(a) && Number.isFinite(b)) {
        pairs.push([a / was - 1, b / now - 1]);
      }
    }
  }

  const its = slope(pairs);
  console.log(
    `  ${name.padEnd(24)} ${Number.isNaN(its.slope) ? "too few" : its.slope.toFixed(3)}` +
    `   (${its.n} pairs)`,
  );
}
