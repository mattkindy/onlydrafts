/**
 * Does a walked drive look like a real one?
 *
 * The shapes to match are measured by the drive shape eval: 5.9 plays
 * a drive, a third of them three or fewer, a tenth eleven or more, and
 * 23.6% ending in a touchdown.
 *
 * Run: npx tsx scripts/driveSimEval.ts
 */

import { seededRng } from "../src/sim/rng.js";
import { fitDriveRules } from "../src/features/driveRules.js";
import { simulateDrive, type DriveEnd } from "../src/model/drive.js";
import { normalDraw } from "../src/sim/normal.js";

async function main(): Promise<void> {
  const rules = await fitDriveRules([2022, 2023, 2024]);
  console.log(`rules from ${rules.plays} plays\n`);

  const swingArg = process.argv.indexOf("--swing");
  const swings = swingArg === -1
    ? [0]
    : (process.argv[swingArg + 1] ?? "").split(",").map(Number);

  for (const swing of swings) {
  const rng = seededRng(64);
  const lengths: number[] = [];
  const endings = new Map<DriveEnd, number>();
  const RUNS = 40000;

  for (let run = 0; run < RUNS; run++) {
    // Where drives actually start, measured rather than guessed: a
    // median of 75 from their own goal, a quarter starting behind 80
    // and a tenth inside 52. My guess of 45 to 75 was far too kind and
    // was making drives short by handing them the ball near the fringe.
    const start = Math.max(
      20, Math.min(99, Math.round(75 + normalDraw(rng) * 13)),
    );
    const going = swing === 0
      ? 1
      : Math.max(0.2, Math.exp(normalDraw(rng) * swing));
    const drive = simulateDrive(start, rules, rng, { going });
    lengths.push(drive.plays.length);
    endings.set(drive.ending, (endings.get(drive.ending) ?? 0) + 1);
  }

  if (swings.length > 1) console.log("\nhow much a drive's form swings: " + swing);

  lengths.sort((a, b) => a - b);
  const share = (test: (n: number) => boolean) =>
    ((lengths.filter(test).length / lengths.length) * 100).toFixed(1) + "%";

  console.log("                        simulated   actual");
  console.log("  plays a drive     " + (lengths.reduce((a, b) => a + b, 0) / lengths.length)
    .toFixed(1).padStart(11) + "      5.9");
  console.log("  three or fewer    " + share((n) => n <= 3).padStart(11) + "    33.9%");
  console.log("  eleven or more    " + share((n) => n >= 11).padStart(11) + "    10.0%");
  console.log("  ends in a score   " +
    (((endings.get("touchdown") ?? 0) / RUNS) * 100).toFixed(1).padStart(10) + "%    23.6%");

  console.log("\nhow they end\n");

  for (const [ending, count] of [...endings].sort((a, b) => b[1] - a[1])) {
    console.log("  " + ending.padEnd(14) + ((count / RUNS) * 100).toFixed(1).padStart(6) + "%");
  }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
