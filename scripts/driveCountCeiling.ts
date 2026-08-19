/**
 * How much of how many drives a side gets is knowable at all.
 *
 * The walk orders it at .113, which is poor, but a number is only
 * poor against what could be had. Both sides of a game get within one
 * of each other, so this is really asking which games run long and
 * which run short. If that barely repeats for a side across a season
 * then .113 is near the ceiling and not worth chasing.
 *
 * Run: npx tsx scripts/driveCountCeiling.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { spearman } from "../src/backtest/metrics.js";

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

const spread = (values: number[]) => {
  const mid = middle(values);
  return Math.sqrt(middle(values.map((v) => (v - mid) ** 2)));
};

async function main(): Promise<void> {
  const rows = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "drives.csv"), "utf8",
  ));
  const count = new Map<string, number>();

  for (const row of rows) {
    if (Number(row["week"]) > 18) {
      continue;
    }

    const key = `${row["season"]}|${row["week"]}|${row["offense"]}`;
    count.set(key, (count.get(key) ?? 0) + 1);
  }

  const every = [...count.values()];
  console.log(
    `${every.length} team games\n\n` +
      `  a side gets ${middle(every).toFixed(1)} drives, give or take ` +
      `${spread(every).toFixed(2)}\n`,
  );

  // the two halves of a side's season against each other, which is
  // the most any model working from the side alone could manage
  const bySide = new Map<string, number[]>();

  for (const [key, n] of count) {
    const [season, week, team] = key.split("|");
    bySide.set(`${season}|${team}`, [
      ...(bySide.get(`${season}|${team}`) ?? []),
      Number(week) <= 9 ? n : -n,
    ]);
  }

  const early: number[] = [];
  const late: number[] = [];

  for (const weeks of bySide.values()) {
    const first = weeks.filter((n) => n > 0);
    const second = weeks.filter((n) => n < 0).map((n) => -n);

    if (first.length < 6 || second.length < 6) {
      continue;
    }

    early.push(middle(first));
    late.push(middle(second));
  }

  console.log(
    `  one half of a side's season against the other, ${early.length} of them\n` +
      `    ${spearman(early, late).toFixed(4)}\n`,
  );

  // and the side they were playing, since a game has two of them in
  // it and everything a side does not account for is not therefore
  // nobody's
  const byDefence = new Map<string, number[]>();

  for (const row of rows) {
    if (Number(row["week"]) > 18) {
      continue;
    }

    const key = `${row["season"]}|${row["week"]}|${row["offense"]}`;
    const n = count.get(key) ?? 0;
    const half = `${row["season"]}|${row["defense"]}`;
    byDefence.set(half, [
      ...(byDefence.get(half) ?? []),
      Number(row["week"]) <= 9 ? n : -n,
    ]);
  }

  const seen = new Set<string>();
  const earlyAgainst: number[] = [];
  const lateAgainst: number[] = [];

  for (const [key, weeks] of byDefence) {
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    // a drive is counted once for every play in it, so take the
    // distinct games rather than the rows
    const first = weeks.filter((n) => n > 0);
    const second = weeks.filter((n) => n < 0).map((n) => -n);

    if (first.length < 6 || second.length < 6) {
      continue;
    }

    earlyAgainst.push(middle(first));
    lateAgainst.push(middle(second));
  }

  console.log(
    `  and the same for the side they played, ${earlyAgainst.length} of them\n` +
      `    ${spearman(earlyAgainst, lateAgainst).toFixed(4)}\n`,
  );

  // and how much of a single game's count is the two sides at all,
  // since both get within one of each other
  const byGame = new Map<string, number[]>();

  for (const [key, n] of count) {
    const [season, week] = key.split("|");
    const row = rows.find((r) =>
      r["season"] === season && r["week"] === week &&
      r["offense"] === key.split("|")[2]);
    const against = row?.["defense"] ?? "";
    const pair = [key.split("|")[2]!, against].sort().join(" v ");
    byGame.set(`${season}|${week}|${pair}`, [
      ...(byGame.get(`${season}|${week}|${pair}`) ?? []), n,
    ]);
  }

  const pairs = [...byGame.values()].filter((v) => v.length === 2);
  console.log(
    `  the two sides in a game, ${pairs.length} of them\n` +
      `    they differ by ${middle(pairs.map((v) => Math.abs(v[0]! - v[1]!))).toFixed(2)} ` +
      "drives on average",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
