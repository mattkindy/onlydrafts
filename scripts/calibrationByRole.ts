/**
 * Is the pooled distribution the right one for each player, or only
 * right on average across players?
 *
 * For every week, find where the actual result fell inside that
 * player's own predicted distribution. If the distribution fits, those
 * positions spread evenly from 0 to 1 whichever player you look at.
 * If lumpy players land in the tails more often than a fifth of the
 * time, the pooled distribution is wrong for them however well it
 * scores on average.
 *
 * Run: npx tsx scripts/calibrationByRole.ts
 */

import { loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import { buildResidualModel, outcomeQuantile } from "../src/backtest/intervals.js";

const SEASONS = [2021, 2022, 2023, 2024, 2025];

interface Season {
  id: string; season: number; position: string; ppg: number;
  points: number[]; concentration: number; targets: number;
  carries: number; adot: number; tdRate: number;
}

function concentrationOf(points: number[]): number {
  const sorted = [...points].sort((a, b) => b - a);
  const best = Math.max(1, Math.round(points.length / 4));
  const total = points.reduce((s, p) => s + p, 0);
  return total > 0 ? sorted.slice(0, best).reduce((s, p) => s + p, 0) / total : 0;
}

const row = (s: Season) => [
  1, s.position === "RB" ? 1 : 0, s.position === "TE" ? 1 : 0,
  s.targets, s.carries, s.targets + s.carries, s.adot, s.tdRate, s.ppg, s.concentration,
];

async function load(season: number): Promise<Season[]> {
  const weeks = await loadPlayerStats(season);
  const by = new Map<string, { position: string; rows: typeof weeks }>();

  for (const w of weeks) {
    if (!["RB", "WR", "TE"].includes(w.position)) continue;
    const e = by.get(w.playerId) ?? { position: w.position, rows: [] as typeof weeks };
    e.rows.push(w);
    by.set(w.playerId, e);
  }

  const out: Season[] = [];

  for (const [id, e] of by) {
    if (e.rows.length < 10) continue;
    const points = e.rows.map((w) => fantasyPoints(w.statLine, presets.standard));
    const ppg = points.reduce((a, b) => a + b, 0) / points.length;
    if (ppg < 4) continue;
    const targets = e.rows.reduce((a, w) => a + w.targets, 0);
    const air = e.rows.reduce((a, w) => a + w.airYards, 0);
    const tds = e.rows.reduce((a, w) => a + (w.statLine.rushTd ?? 0) + (w.statLine.recTd ?? 0), 0);
    out.push({
      id, season, position: e.position, ppg, points,
      concentration: concentrationOf(points),
      targets: targets / e.rows.length,
      carries: e.rows.reduce((a, w) => a + w.carries, 0) / e.rows.length,
      adot: targets > 0 ? air / targets : 0,
      tdRate: tds / e.rows.length,
    });
  }

  return out;
}

async function main(): Promise<void> {
  const bySeason = new Map<number, Season[]>();
  for (const s of SEASONS) bySeason.set(s, await load(s));
  const pairs: { prev: Season; next: Season }[] = [];

  for (const s of SEASONS.slice(1)) {
    const prior = new Map((bySeason.get(s - 1) ?? []).map((r) => [r.id, r]));
    for (const r of bySeason.get(s) ?? []) {
      const prev = prior.get(r.id);
      if (prev && prev.position === r.position) pairs.push({ prev, next: r });
    }
  }

  const test = pairs.filter((p) => p.next.season === 2025);
  const train = pairs.filter((p) => p.next.season < 2025);
  const shapeWeights = fitRidge(
    train.map((p) => row(p.prev)), train.map((p) => p.next.concentration), 1,
  );
  const flat = buildResidualModel(
    train.flatMap((p) =>
      p.next.points.map((actual) => ({
        position: p.next.position, predicted: p.prev.ppg, actual,
      }))),
    5,
  );

  // where each actual week landed inside that player's own curve
  const GRID = Array.from({ length: 41 }, (_, i) => i / 40);
  const withRank = test.map((p) => {
    const curve = GRID.map((q) => outcomeQuantile(flat, p.next.position, p.prev.ppg, q));
    const places = p.next.points.map((actual) => {
      let i = 0;
      while (i < curve.length && curve[i]! < actual) i++;
      return Math.min(1, i / (curve.length - 1));
    });
    return { p, places, predicted: predictRidge(shapeWeights, row(p.prev)) };
  });

  const sorted = [...withRank].sort((a, b) => a.predicted - b.predicted);
  const third = Math.floor(sorted.length / 3);
  const groups: [string, typeof sorted][] = [
    ["steadiest third", sorted.slice(0, third)],
    ["middle third", sorted.slice(third, third * 2)],
    ["lumpiest third", sorted.slice(third * 2)],
  ];

  console.log("2025, where each week landed inside that player's own curve\n");
  console.log("if the curve fits him, each fifth below holds 20%\n");
  console.log("group              n weeks   bottom  low-mid   middle  high-mid      top");

  for (const [label, group] of groups) {
    const places = group.flatMap((g) => g.places);
    const fifths = [0, 0, 0, 0, 0];
    for (const place of places) fifths[Math.min(4, Math.floor(place * 5))]!++;
    console.log(
      label.padEnd(18) + String(places.length).padStart(7) +
      fifths.map((c) => ((c / places.length) * 100).toFixed(1).padStart(9) + "%").join(""),
    );
  }

  console.log("\nshare landing in the outer fifths (20% + 20% = 40% if the curve fits):");

  for (const [label, group] of groups) {
    const places = group.flatMap((g) => g.places);
    const tails = places.filter((x) => x < 0.2 || x >= 0.8).length / places.length;
    console.log("  " + label.padEnd(18) + (tails * 100).toFixed(1) + "%");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
