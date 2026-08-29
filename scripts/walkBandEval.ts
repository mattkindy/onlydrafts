/**
 * Are the walk's per game bands calibrated?
 *
 * The card is switching its spread from the role simulation's bands,
 * kept because an 80% band covered 79.6%, to the walk's own dealt
 * games. This asks the same question of the walk: over a played
 * season, how many of a man's weeks as they were scored land inside
 * the 10th to 90th of the games the walk dealt him?
 *
 * Run: npx tsx scripts/walkBandEval.ts [season]
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";

const SEASON = Number(process.argv[2] ?? 2025);
const POSITIONS = ["QB", "RB", "WR", "TE"];

const kept = JSON.parse(await readFile(
  join(import.meta.dirname, "..", "data", "kept", `played-${SEASON}.json`),
  "utf8",
)) as { samples?: [string, number[]][] };
const samples = new Map(kept.samples ?? []);

const weekly = new Map<string, number[]>();
const positionOf = new Map<string, string>();

for (const s of await loadPlayerStats(SEASON)) {
  positionOf.set(s.playerId, s.position);
  weekly.set(s.playerId, [
    ...(weekly.get(s.playerId) ?? []),
    fantasyPoints(s.statLine, presets.ppr),
  ]);
}

/**
 * The walk deals every week from one world, so its games vary less
 * than a season's weeks, which also carry role changes and hurt
 * teammates. `wider` stretches each band around its middle to put
 * that missing variety back; the sweep says how much is missing.
 */
const coverage = (wider: number) => {
  let weeks = 0;
  let inside = 0;
  let widths = 0;
  let men = 0;

  for (const [playerId, his] of samples) {
    const was = weekly.get(playerId) ?? [];
    const position = positionOf.get(playerId) ?? "";

    if (his.length < 40 || was.length < 8 || !POSITIONS.includes(position)) {
      continue;
    }

    const sorted = [...his].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.floor(q * (sorted.length - 1))]!;
    const middle = at(0.5);

    if (middle < 6) {
      continue;
    }

    const low = Math.max(0, middle + (at(0.1) - middle) * wider);
    const high = middle + (at(0.9) - middle) * wider;
    men++;
    widths += high - low;

    for (const points of was) {
      weeks++;

      if (points >= low && points <= high) {
        inside++;
      }
    }
  }

  console.log(
    `wider ${wider.toFixed(2)}: ${men} men, ${weeks} played weeks, ` +
    `${(100 * inside / weeks).toFixed(1)}% inside the 10th to 90th ` +
    `(should be 80), bands ${(widths / men).toFixed(1)} points wide`,
  );
};

for (const wider of [1, 1.1, 1.15, 1.2, 1.3]) {
  coverage(wider);
}
