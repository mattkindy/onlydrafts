/**
 * How a side kicks or goes for two after a touchdown, measured off the
 * raw play by play.
 *
 * `gameFromDrives.ts` scores every touchdown as a flat 7, which is
 * not what an NFL side does: it misses some extra points and goes
 * for two on a slice of touchdowns, mostly when the score right after
 * the six calls for it. This prints what that slice looks like, so
 * `afterTouchdown.ts` can be fitted from it rather than guessed at.
 *
 * Run: npx tsx scripts/twoPointEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";

const SEASONS = [2022, 2023, 2024, 2025];

interface Try {
  two: boolean;
  made: boolean;
  margin: number;
  quarter: number;
  call: "run" | "pass" | "";
  hasReceiver: boolean;
}

async function load(): Promise<Try[]> {
  const tries: Try[] = [];

  for (const season of SEASONS) {
    const text = await readFile(
      join(import.meta.dirname, "..", "data", "raw", `play_by_play_${season}.csv`),
      "utf8",
    );

    for (const row of parseCsv(text)) {
      const type = row["play_type"];
      const isExtraPoint = type === "extra_point";
      const isTwoPoint = type === "two_point_attempt" || row["two_point_attempt"] === "1";

      if (!isExtraPoint && !isTwoPoint) {
        continue;
      }

      const made = isTwoPoint
        ? row["two_point_conv_result"] === "success"
        : row["extra_point_result"] === "good";
      const call = row["rusher_player_id"] ? "run"
        : row["passer_player_id"] ? "pass"
        : "";

      tries.push({
        two: isTwoPoint,
        made,
        margin: Number(row["score_differential"]) || 0,
        quarter: Number(row["qtr"]) || 0,
        call,
        hasReceiver: Boolean(row["receiver_player_id"]),
      });
    }
  }

  return tries;
}

function rate(of: Try[], keep: (t: Try) => boolean): string {
  const kept = of.filter(keep);
  const made = kept.filter((t) => t.made).length;

  return kept.length === 0 ? "n/a" : `${(100 * made / kept.length).toFixed(1)}% (n=${kept.length})`;
}

async function main(): Promise<void> {
  const tries = await load();
  const extraPoints = tries.filter((t) => !t.two);
  const twoPoints = tries.filter((t) => t.two);

  console.log(`extra point make rate: ${rate(extraPoints, () => true)}`);
  console.log(`go for two rate: ${(100 * twoPoints.length / tries.length).toFixed(1)}% ` +
    `of ${tries.length} tries`);
  console.log(`two point conversion rate: ${rate(twoPoints, () => true)}`);

  console.log("\ngo for two, by the margin right after the six:");
  const margins = [...new Set(tries.map((t) => t.margin))].sort((a, b) => a - b);

  for (const margin of margins) {
    const here = tries.filter((t) => t.margin === margin);

    if (here.length < 20) {
      continue;
    }

    const twoHere = here.filter((t) => t.two).length;
    console.log(
      `  margin ${margin >= 0 ? "+" : ""}${margin}: ` +
      `go for two ${(100 * twoHere / here.length).toFixed(1)}% (n=${here.length}), ` +
      `converts ${rate(here, (t) => t.two)}`,
    );
  }

  console.log("\ngo for two, by quarter:");
  for (const quarter of [1, 2, 3, 4, 5]) {
    const here = tries.filter((t) => t.quarter === quarter);

    if (here.length === 0) {
      continue;
    }

    const twoHere = here.filter((t) => t.two).length;
    console.log(
      `  quarter ${quarter}: go for two ${(100 * twoHere / here.length).toFixed(1)}% ` +
      `(n=${here.length})`,
    );
  }

  console.log("\ntwo point tries, run vs pass, and who got credit:");
  const runs = twoPoints.filter((t) => t.call === "run").length;
  const passes = twoPoints.filter((t) => t.call === "pass").length;
  console.log(`  run ${(100 * runs / twoPoints.length).toFixed(1)}%, ` +
    `pass ${(100 * passes / twoPoints.length).toFixed(1)}%`);

  const passTries = twoPoints.filter((t) => t.call === "pass");
  const withReceiver = passTries.filter((t) => t.hasReceiver).length;
  console.log(`  runs are credited to the rusher; passes are credited to the ` +
    `passer and, ${(100 * withReceiver / passTries.length).toFixed(1)}% of the ` +
    `time, a named receiver`);
}

main();
