/**
 * Whether going for it is trending, and whether a trailing average or a
 * slope would have seen the jump coming.
 *
 * Sides went for it on 76% of fourth and short inside the ten in 2025
 * against 56% the year before, and a model fitted on the earlier
 * seasons misses it. Three seasons is too short to tell a jump from a
 * climb, so this goes back as far as the release does.
 *
 * Run: npx tsx scripts/fourthTrendEval.ts
 */

import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { RAW_DIR } from "../src/data/nflverse.js";
import { splitLine } from "../src/data/csv.js";

const SEASONS = [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];

async function rateFor(season: number) {
  const path = join(RAW_DIR, `play_by_play_${season}.csv`);

  if (!existsSync(path)) {
    return null;
  }

  const reader = createInterface({ input: createReadStream(path) });
  let header: string[] | undefined;
  const at: Record<string, number> = {};
  let went = 0;
  let all = 0;
  let wentAny = 0;
  let allAny = 0;

  for await (const line of reader) {
    if (!header) {
      header = splitLine(line);
      for (const field of ["down", "ydstogo", "yardline_100", "play_type"]) {
        at[field] = header.indexOf(field);
      }
      continue;
    }

    const c = splitLine(line);

    if (Number(c[at["down"]!]) !== 4) {
      continue;
    }

    const type = c[at["play_type"]!] ?? "";

    if (!["run", "pass", "punt", "field_goal"].includes(type)) {
      continue;
    }

    const going = ["run", "pass"].includes(type) ? 1 : 0;
    const toGo = Number(c[at["ydstogo"]!]);
    const yardline = Number(c[at["yardline_100"]!]);
    allAny++;
    wentAny += going;

    if (toGo <= 3 && yardline <= 10) {
      all++;
      went += going;
    }
  }

  return { close: went / Math.max(1, all), closeSeen: all, any: wentAny / allAny };
}

async function main(): Promise<void> {
  const series: { season: number; close: number; any: number }[] = [];

  for (const season of SEASONS) {
    const found = await rateFor(season);

    if (found) {
      series.push({ season, close: found.close, any: found.any });
    }
  }

  console.log("how often a side goes for it   short inside the ten   any fourth down");

  for (const row of series) {
    console.log(
      "  " + row.season + "  " +
      `${(100 * row.close).toFixed(0)}%`.padStart(18) +
      `${(100 * row.any).toFixed(1)}%`.padStart(19),
    );
  }

  // would a trailing average, or the slope, have called the next one
  const guesses: [string, (before: typeof series) => number][] = [
    ["last season alone", (b) => b[b.length - 1]!.close],
    ["the last three, level", (b) =>
      b.slice(-3).reduce((a, r) => a + r.close, 0) / Math.min(3, b.length)],
    ["the last three, weighted to now", (b) => {
      const use = b.slice(-3);
      const weights = [0.2, 0.3, 0.5].slice(-use.length);
      const total = weights.reduce((a, w) => a + w, 0);
      return use.reduce((a, r, i) => a + r.close * weights[i]!, 0) / total;
    }],
    ["carrying the slope forward", (b) => {
      const use = b.slice(-4);

      if (use.length < 3) {
        return use[use.length - 1]!.close;
      }

      const n = use.length;
      const meanX = (n - 1) / 2;
      const meanY = use.reduce((a, r) => a + r.close, 0) / n;
      let top = 0;
      let bottom = 0;

      use.forEach((r, i) => {
        top += (i - meanX) * (r.close - meanY);
        bottom += (i - meanX) ** 2;
      });

      return meanY + (top / bottom) * (n - meanX);
    }],
  ];

  console.log("\nguessing each season from the ones before it, average miss");

  for (const [label, say] of guesses) {
    const misses: number[] = [];

    for (let i = 4; i < series.length; i++) {
      misses.push(Math.abs(say(series.slice(0, i)) - series[i]!.close));
    }

    console.log(
      "  " + label.padEnd(34) +
      `${(100 * misses.reduce((a, b) => a + b, 0) / misses.length).toFixed(1)} points`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
