/**
 * How firmly does a depth chart hold from week to week?
 *
 * The simulation splits a team's passes and hand-offs by drawing each
 * man's appetite and normalising, and `firmness` says how far those
 * draws wander. I set it to 12 by eye. Fit it instead: gather every
 * team-week's actual shares, and find the firmness whose draws spread
 * the way the real weeks spread.
 *
 * Run: npx tsx scripts/firmnessEval.ts
 */

import { loadPlayerStats } from "../src/data/nflverse.js";
import { loadCoaches } from "../src/data/coaches.js";
import { seededRng } from "../src/sim/rng.js";
import { normalDraw } from "../src/sim/normal.js";
import { shareDraw, type Draws } from "../src/model/playerWeek.js";

const SEASONS = [2021, 2022, 2023, 2024, 2025];

/** how much a set of weekly shares moved around their own average */
function wobble(weekly: number[][], season: number[]): number {
  let total = 0;
  let count = 0;

  for (let i = 0; i < season.length; i++) {
    if (season[i]! < 0.05) continue;
    const mine = weekly.map((w) => w[i]!);
    const mean = mine.reduce((a, b) => a + b, 0) / mine.length;
    if (mean <= 0) continue;
    const variance =
      mine.reduce((a, b) => a + (b - mean) ** 2, 0) / mine.length;
    total += Math.sqrt(variance) / mean;
    count++;
  }

  return count > 0 ? total / count : 0;
}

/** the same measure, from simulated weeks at a given firmness */
function simulatedWobble(shares: number[], firmness: number, draws: Draws): number {
  const weeks = Array.from({ length: 400 }, () => shareDraw(shares, firmness, draws));
  return wobble(weeks, shares);
}

async function main(): Promise<void> {
  const coaches = await loadCoaches();
  const rng = seededRng(23);
  const draws: Draws = { uniform: rng, normal: () => normalDraw(rng) };

  const groups = new Map<string, { real: number[]; shares: number[][] }>();

  for (const season of SEASONS) {
    const stats = await loadPlayerStats(season);
    const byTeam = new Map<string, typeof stats>();

    for (const s of stats) {
      byTeam.set(s.teamId, [...(byTeam.get(s.teamId) ?? []), s]);
    }

    for (const [team, rows] of byTeam) {
      const oc = coaches.get(`${team}|${season}|OC`) ?? "";
      const before = coaches.get(`${team}|${season - 1}|OC`) ?? "";
      const sameStaff = oc !== "" && before !== "" && oc === before;

      for (const [what, take] of [
        ["carries", (s: (typeof stats)[number]) => s.carries],
        ["targets", (s: (typeof stats)[number]) => s.targets],
      ] as [string, (s: (typeof stats)[number]) => number][]) {
        const players = [...new Set(rows.map((r) => r.playerId))];
        const seasonTotal = players.map((p) =>
          rows.filter((r) => r.playerId === p).reduce((a, r) => a + take(r), 0));
        const all = seasonTotal.reduce((a, b) => a + b, 0);
        if (all < 200) continue;
        const shares = seasonTotal.map((t) => t / all);

        const weeks = [...new Set(rows.map((r) => r.week))].sort((a, b) => a - b);
        const weekly: number[][] = [];

        for (const week of weeks) {
          const inWeek = rows.filter((r) => r.week === week);
          const weekTotal = inWeek.reduce((a, r) => a + take(r), 0);
          if (weekTotal < 10) continue;
          weekly.push(players.map((p) =>
            inWeek.filter((r) => r.playerId === p).reduce((a, r) => a + take(r), 0) / weekTotal));
        }

        if (weekly.length < 10) continue;

        for (const key of [what, `${what}, ${sameStaff ? "staff kept" : "staff changed"}`]) {
          const g = groups.get(key) ?? { real: [], shares: [] };
          g.real.push(wobble(weekly, shares));
          g.shares.push(shares);
          groups.set(key, g);
        }
      }
    }
  }

  console.log("how far a man's weekly share wanders from his season share\n");
  console.log("group                          n    actual   best firmness   simulated");

  for (const [label, g] of groups) {
    const actual = g.real.reduce((a, b) => a + b, 0) / g.real.length;
    let best = { firmness: 0, wobble: 0, gap: Infinity };

    for (const firmness of [2, 3, 4, 6, 8, 12, 16, 24, 40]) {
      const simulated =
        g.shares.slice(0, 60)
          .map((shares) => simulatedWobble(shares, firmness, draws))
          .reduce((a, b) => a + b, 0) / Math.min(60, g.shares.length);
      const gap = Math.abs(simulated - actual);
      if (gap < best.gap) best = { firmness, wobble: simulated, gap };
    }

    console.log(
      label.padEnd(30) + String(g.real.length).padStart(4) +
      actual.toFixed(3).padStart(10) + String(best.firmness).padStart(16) +
      best.wobble.toFixed(3).padStart(12),
    );
  }

  console.log("\nthe simulation currently uses 12 for everything");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
