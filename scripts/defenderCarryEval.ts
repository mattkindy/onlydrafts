/**
 * Does a defender carry more of himself than his defence does?
 *
 * A team's defensive index keeps about 0.200 of itself from one season
 * to the next, and how much of the roster stayed makes no difference to
 * that, which is a sign the team number is mostly noise. If the men are
 * where the signal is, then one corner's own coverage should persist a
 * good deal better than the side he plays for.
 *
 * Run: npx tsx scripts/defenderCarryEval.ts
 */

import { parseCsv } from "../src/data/csv.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SEASONS = [2021, 2022, 2023, 2024, 2025];
/** below this many targets a season, one bad afternoon moves everything */
const ENOUGH = 40;

const rows = parseCsv(await readFile(
  join(import.meta.dirname, "..", "data", "curated", "coverage.csv"), "utf8"));

interface Line {
  targets: number;
  completions: number;
  yards: number;
  touchdowns: number;
  interceptions: number;
  brokenUp: number;
}

const his = new Map<string, Line>();

for (const r of rows) {
  const key = `${r["season"]}|${r["player"]}|${r["spot"]}`;
  const so = his.get(key) ?? {
    targets: 0, completions: 0, yards: 0,
    touchdowns: 0, interceptions: 0, brokenUp: 0,
  };
  so.targets += Number(r["targets"]) || 0;
  so.completions += Number(r["completions"]) || 0;
  so.yards += Number(r["yards"]) || 0;
  so.touchdowns += Number(r["touchdowns"]) || 0;
  so.interceptions += Number(r["interceptions"]) || 0;
  so.brokenUp += Number(r["brokenUp"]) || 0;
  his.set(key, so);
}

/** the ways a corner can be judged, each against what everyone at his spot did */
const WAYS: [string, (l: Line) => number][] = [
  ["yards a target", (l) => l.yards / l.targets],
  ["caught on him", (l) => l.completions / l.targets],
  ["yards a catch", (l) => l.yards / Math.max(1, l.completions)],
  ["broken up a target", (l) => l.brokenUp / l.targets],
  ["how often thrown at", (l) => l.targets],
];

function slope(pairs: [number, number][]): { slope: number; n: number } {
  const n = pairs.length;

  if (n < 20) {
    return { slope: NaN, n };
  }

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

console.log("How much of a defender is there next season.");
console.log("A team defence manages 0.200, whoever it keeps.\n");
console.log("                            CB              S");

for (const [name, of] of WAYS) {
  const line: string[] = [];

  for (const spot of ["CB", "S"]) {
    const pairs: [number, number][] = [];

    for (let i = 1; i < SEASONS.length; i++) {
      const before = SEASONS[i - 1]!;
      const after = SEASONS[i]!;
      const level = (season: number) => {
        const all = [...his.entries()]
          .filter(([k, l]) => k.startsWith(`${season}|`) &&
            k.endsWith(`|${spot}`) && l.targets >= ENOUGH);
        const mean = all.reduce((s, [, l]) => s + of(l), 0) / Math.max(1, all.length);

        return mean;
      };
      const wasLevel = level(before);
      const nowLevel = level(after);

      for (const [key, line] of his) {
        if (!key.startsWith(`${before}|`) || !key.endsWith(`|${spot}`) ||
            line.targets < ENOUGH) {
          continue;
        }

        const who = key.split("|")[1]!;
        const next = his.get(`${after}|${who}|${spot}`);

        if (!next || next.targets < ENOUGH) {
          continue;
        }

        pairs.push([of(line) / wasLevel - 1, of(next) / nowLevel - 1]);
      }
    }

    const its = slope(pairs);
    line.push(Number.isNaN(its.slope)
      ? `too few (${its.n})`.padEnd(14)
      : `${its.slope.toFixed(3)} (${its.n})`.padEnd(14));
  }

  console.log(`  ${name.padEnd(24)} ${line.join("  ")}`);
}
