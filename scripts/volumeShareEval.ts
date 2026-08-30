/**
 * How much of a man's week is how often he touched it?
 *
 * Five changes that told the walk more about the people on a play all
 * helped passers and receivers and cost backs, which is too steady to
 * be luck. This is why: they are all improvements to what a touch is
 * worth, and positions differ in how much that decides a week.
 *
 * Run: npx tsx scripts/volumeShareEval.ts [seasons, comma separated]
 */

import { loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { spearman } from "../src/backtest/metrics.js";

const SEASONS = (process.argv[2] ?? "2024,2025").split(",").map(Number);
const POSITIONS = ["QB", "RB", "WR", "TE"];

const rows = new Map<string, {
  touches: number[]; points: number[]; per: number[];
}>();

for (const season of SEASONS) {
  for (const s of await loadPlayerStats(season)) {
    if (s.week > 18 || !POSITIONS.includes(s.position)) {
      continue;
    }

    const touches =
      (s.carries ?? 0) + (s.targets ?? 0) + (s.passing?.attempts ?? 0);

    if (touches < 1) {
      continue;
    }

    const points = fantasyPoints(s.statLine, presets.ppr);
    const own = rows.get(s.position) ??
      { touches: [], points: [], per: [] };
    own.touches.push(touches);
    own.points.push(points);
    own.per.push(points / touches);
    rows.set(s.position, own);
  }
}

console.log(`over ${SEASONS.join(" and ")}, every week of a man:`);

for (const position of POSITIONS) {
  const own = rows.get(position);

  if (!own) {
    continue;
  }

  console.log(
    `  ${position}  ${String(own.points.length).padStart(5)} weeks  ` +
    `how often he touched it orders his points ` +
    `${spearman(own.touches, own.points).toFixed(3)}  ` +
    `what he made of each ${spearman(own.per, own.points).toFixed(3)}`,
  );
}
