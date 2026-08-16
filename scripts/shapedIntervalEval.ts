/**
 * Does splitting residuals by how lumpy a player's role is give better
 * bands than splitting by position and scoring level alone? Scored
 * per player rather than pooled, because pooled coverage is exactly
 * the number that let the old bands look fine while giving a deep
 * threat and a possession receiver the same range.
 *
 * Run: npx tsx scripts/shapedIntervalEval.ts
 */

import { loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import {
  buildResidualModel, outcomeQuantile,
  buildShapedResidualModel, shapedQuantile,
  type ShapedTrainingPoint,
} from "../src/backtest/intervals.js";

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
  const shapeWeights = fitRidge(train.map((p) => row(p.prev)), train.map((p) => p.next.concentration), 1);

  // every week of every training season, labelled with the role we would
  // have predicted for that player before the season began
  const flatPoints = [];
  const shapedPoints: ShapedTrainingPoint[] = [];

  for (const p of train) {
    const predictedPpg = p.prev.ppg;
    const concentration = predictRidge(shapeWeights, row(p.prev));

    for (const actual of p.next.points) {
      flatPoints.push({ position: p.next.position, predicted: predictedPpg, actual });
      shapedPoints.push({ position: p.next.position, predicted: predictedPpg, actual, concentration });
    }
  }

  const flat = buildResidualModel(flatPoints, 5);
  const shaped = buildShapedResidualModel(shapedPoints, 5, 3);

  // per player: does his own 10th to 90th band hold his own weeks?
  const score = (label: string, q: (p: typeof test[number], at: number) => number) => {
    const widths: number[] = [];
    let inside = 0, total = 0;
    let pinball = 0;

    for (const p of test) {
      const lo = q(p, 0.1), hi = q(p, 0.9);
      widths.push(hi - lo);

      for (const actual of p.next.points) {
        total++;
        if (actual >= lo && actual <= hi) inside++;
        for (const [at, edge] of [[0.1, lo], [0.9, hi]] as [number, number][]) {
          pinball += actual >= edge ? at * (actual - edge) : (1 - at) * (edge - actual);
        }
      }
    }

    widths.sort((a, b) => a - b);
    console.log(
      label.padEnd(28) + ((inside / total) * 100).toFixed(1).padStart(9) + "%" +
      (pinball / total).toFixed(3).padStart(11) +
      widths[Math.floor(widths.length * 0.1)]!.toFixed(1).padStart(11) +
      widths[Math.floor(widths.length * 0.9)]!.toFixed(1).padStart(9),
    );
  };

  console.log("2025, " + test.length + " players, " +
    test.reduce((a, p) => a + p.next.points.length, 0) + " weeks\n");
  console.log("band from                   coverage    pinball   narrowest     widest");
  console.log("                              (want 80%)          (10th pct)  (90th pct)");

  const flatQ = (p: typeof test[number], at: number) =>
    outcomeQuantile(flat, p.next.position, p.prev.ppg, at);
  const shapedQ = (p: typeof test[number], at: number) =>
    shapedQuantile(shaped, p.next.position, p.prev.ppg,
      predictRidge(shapeWeights, row(p.prev)), at);

  score("position and level", flatQ);

  // Concentration describes the shape of a season, not the width of a
  // middle band, so score each edge on its own. Ceiling is what you
  // actually reach for a boom or bust player.
  const edge = (label: string, at: number) => {
    let flatLoss = 0, shapedLoss = 0, n = 0;
    const flatW: number[] = [], shapedW: number[] = [];

    for (const p of test) {
      const f = flatQ(p, at), h = shapedQ(p, at);
      flatW.push(f); shapedW.push(h);

      for (const actual of p.next.points) {
        n++;
        flatLoss += actual >= f ? at * (actual - f) : (1 - at) * (f - actual);
        shapedLoss += actual >= h ? at * (actual - h) : (1 - at) * (h - actual);
      }
    }

    const sd = (xs: number[]) => {
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
    };
    console.log(
      label.padEnd(20) + (flatLoss / n).toFixed(4).padStart(10) +
      (shapedLoss / n).toFixed(4).padStart(11) +
      (((flatLoss - shapedLoss) / flatLoss) * 100).toFixed(2).padStart(10) + "%" +
      sd(flatW).toFixed(2).padStart(10) + sd(shapedW).toFixed(2).padStart(9),
    );
  };

  console.log("\nby edge, pinball loss (lower is better)\n");
  console.log("edge                    pooled  with role   role gains   spread of each");
  for (const [label, at] of [["floor, 10th", 0.1], ["25th", 0.25],
    ["median", 0.5], ["75th", 0.75], ["ceiling, 90th", 0.9],
    ["ceiling, 95th", 0.95]] as [string, number][]) edge(label, at);
  console.log("");

  // the shaped bands are noisier because each one sees a third of the
  // data, so pull them back toward the pooled ones and find the weight
  for (const w of [0.2, 0.3, 0.4, 0.5, 0.7, 1.0]) {
    score(
      w === 1 ? "role only" : "role at " + w.toFixed(1) + " toward pooled",
      (p, at) => (1 - w) * flatQ(p, at) + w * shapedQ(p, at),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
