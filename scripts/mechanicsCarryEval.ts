/**
 * Which parts of a play last, and which are the afternoon.
 *
 * Yards a carry is two things added up: how far he got before anyone
 * touched him, which is mostly the men in front of him, and how far he
 * got afterwards, which is him. They should not last equally, and a
 * projection built on the total cannot tell them apart.
 *
 * Run: npx tsx scripts/mechanicsCarryEval.ts
 */

import { parseCsv } from "../src/data/csv.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SEASONS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];

type Row = Record<string, string>;

const n = (r: Row, key: string) => Number(r[key]);

/** a man needs this much of a season before his rates mean anything */
const ENOUGH_CARRIES = 80;
const ENOUGH_TARGETS = 45;

interface Way {
  name: string;
  /** what to measure, and how much of a season is behind it */
  of: (r: Row) => number;
  weight: (r: Row) => number;
}

const RUSHING: Way[] = [
  { name: "yards a carry", of: (r) => n(r, "yds") / n(r, "att"), weight: (r) => n(r, "att") },
  { name: "  before contact", of: (r) => n(r, "ybc_att"), weight: (r) => n(r, "att") },
  { name: "  after contact", of: (r) => n(r, "yac_att"), weight: (r) => n(r, "att") },
  { name: "carries a broken tackle", of: (r) => n(r, "att_br"), weight: (r) => n(r, "att") },
  { name: "carries a game", of: (r) => n(r, "att") / n(r, "g"), weight: (r) => n(r, "att") },
];

const RECEIVING: Way[] = [
  { name: "yards a target", of: (r) => n(r, "yds") / n(r, "tgt"), weight: (r) => n(r, "tgt") },
  { name: "  before the catch", of: (r) => n(r, "ybc_r"), weight: (r) => n(r, "rec") },
  { name: "  after the catch", of: (r) => n(r, "yac_r"), weight: (r) => n(r, "rec") },
  { name: "how deep he is thrown", of: (r) => n(r, "adot"), weight: (r) => n(r, "tgt") },
  { name: "caught a target", of: (r) => n(r, "rec") / n(r, "tgt"), weight: (r) => n(r, "tgt") },
  { name: "dropped a target", of: (r) => n(r, "drop") / n(r, "tgt"), weight: (r) => n(r, "tgt") },
  { name: "targets a game", of: (r) => n(r, "tgt") / n(r, "g"), weight: (r) => n(r, "tgt") },
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

async function report(
  file: string, ways: Way[], enough: number, of: (r: Row) => number, label: string,
) {
  const rows = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "raw", file), "utf8"));
  const bySeason = new Map<number, Map<string, Row>>();

  for (const r of rows) {
    const season = Number(r["season"]);
    const who = r["pfr_id"] ?? "";

    if (!SEASONS.includes(season) || !who || of(r) < enough) {
      continue;
    }

    const table = bySeason.get(season) ?? new Map<string, Row>();
    table.set(who, r);
    bySeason.set(season, table);
  }

  console.log(`\n${label}\n`);

  for (const way of ways) {
    const pairs: [number, number][] = [];

    for (let i = 1; i < SEASONS.length; i++) {
      const before = bySeason.get(SEASONS[i - 1]!);
      const after = bySeason.get(SEASONS[i]!);

      if (!before || !after) {
        continue;
      }

      // each season against its own level, so a year the whole league
      // ran better does not read as everybody improving
      const levelOf = (table: Map<string, Row>) => {
        const all = [...table.values()].map(way.of).filter(Number.isFinite);

        return all.reduce((s, v) => s + v, 0) / Math.max(1, all.length);
      };
      const wasLevel = levelOf(before);
      const nowLevel = levelOf(after);

      for (const [who, row] of before) {
        const next = after.get(who);

        if (!next) {
          continue;
        }

        const was = way.of(row);
        const now = way.of(next);

        if (Number.isFinite(was) && Number.isFinite(now) &&
            wasLevel !== 0 && nowLevel !== 0) {
          pairs.push([was / wasLevel - 1, now / nowLevel - 1]);
        }
      }
    }

    const its = slope(pairs);
    console.log(
      `  ${way.name.padEnd(26)} ${Number.isNaN(its.slope) ? "too few" : its.slope.toFixed(3)}` +
      `   (${its.n} pairs)`,
    );
  }
}

console.log("How much of a man is there next season, part by part.");
console.log("A defence manages about 0.20 whatever we ask of it.");

await report("advstats_rush.csv", RUSHING, ENOUGH_CARRIES, (r) => n(r, "att"),
  "Running the ball");
await report("advstats_rec.csv", RECEIVING, ENOUGH_TARGETS, (r) => n(r, "tgt"),
  "Catching it");
