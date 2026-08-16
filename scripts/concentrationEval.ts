/**
 * Can we predict how lumpy a player's season will be from his role?
 * Concentration here is the share of his season that came in his best
 * quarter of weeks: about .37 for a steady possession receiver, .58
 * for a deep threat at the same average.
 *
 * Run: npx tsx scripts/concentrationEval.ts
 */

import { loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import { spearman } from "../src/backtest/metrics.js";

const SEASONS = [2021, 2022, 2023, 2024, 2025];

interface Row {
  id: string;
  season: number;
  position: string;
  ppg: number;
  concentration: number;
  targets: number;
  carries: number;
  adot: number;
  tdRate: number;
  games: number;
}

/** share of the season that came in the best quarter of weeks */
function concentrationOf(points: number[]): number {
  const sorted = [...points].sort((a, b) => b - a);
  const best = Math.max(1, Math.round(points.length / 4));
  const total = points.reduce((sum, p) => sum + p, 0);
  return total > 0 ? sorted.slice(0, best).reduce((sum, p) => sum + p, 0) / total : 0;
}

function featureRow(prev: Row): number[] {
  return [
    1,
    prev.position === "RB" ? 1 : 0,
    prev.position === "TE" ? 1 : 0,
    prev.targets,
    prev.carries,
    prev.targets + prev.carries,
    prev.adot,
    prev.tdRate,
    prev.ppg,
    prev.concentration,
  ];
}

async function seasonRows(season: number): Promise<Row[]> {
  const weeks = await loadPlayerStats(season);
  const byPlayer = new Map<string, { position: string; rows: typeof weeks }>();

  for (const w of weeks) {
    if (!["RB", "WR", "TE"].includes(w.position)) {
      continue;
    }

    const entry = byPlayer.get(w.playerId) ?? { position: w.position, rows: [] as typeof weeks };
    entry.rows.push(w);
    byPlayer.set(w.playerId, entry);
  }

  const out: Row[] = [];

  for (const [id, entry] of byPlayer) {
    if (entry.rows.length < 10) {
      continue;
    }

    const points = entry.rows.map((w) => fantasyPoints(w.statLine, presets.standard));
    const ppg = points.reduce((a, b) => a + b, 0) / points.length;

    if (ppg < 4) {
      continue;
    }

    const targets = entry.rows.reduce((a, w) => a + w.targets, 0);
    const air = entry.rows.reduce((a, w) => a + w.airYards, 0);
    const tds = entry.rows.reduce(
      (a, w) => a + (w.statLine.rushTd ?? 0) + (w.statLine.recTd ?? 0),
      0,
    );
    out.push({
      id, season, position: entry.position, ppg,
      concentration: concentrationOf(points),
      targets: targets / entry.rows.length,
      carries: entry.rows.reduce((a, w) => a + w.carries, 0) / entry.rows.length,
      adot: targets > 0 ? air / targets : 0,
      tdRate: tds / entry.rows.length,
      games: entry.rows.length,
    });
  }

  return out;
}

async function main(): Promise<void> {
  const bySeason = new Map<number, Row[]>();

  for (const season of SEASONS) {
    bySeason.set(season, await seasonRows(season));
  }

  const pairs: { prev: Row; next: Row }[] = [];

  for (const season of SEASONS.slice(1)) {
    const prior = new Map((bySeason.get(season - 1) ?? []).map((r) => [r.id, r]));

    for (const row of bySeason.get(season) ?? []) {
      const prev = prior.get(row.id);

      if (prev && prev.position === row.position) {
        pairs.push({ prev, next: row });
      }
    }
  }

  console.log(`${pairs.length} player-season pairs\n`);
  console.log("trained on earlier seasons only, scored on the next one\n");
  console.log("season   n    his own past   role model   average for his position");

  for (const season of SEASONS.slice(2)) {
    const train = pairs.filter((p) => p.next.season < season);
    const test = pairs.filter((p) => p.next.season === season);

    if (train.length < 100 || test.length < 30) {
      continue;
    }

    const weights = fitRidge(
      train.map((p) => featureRow(p.prev)),
      train.map((p) => p.next.concentration),
      1,
    );
    const actual = test.map((p) => p.next.concentration);
    const byPosition = new Map<string, number>();

    for (const position of ["RB", "WR", "TE"]) {
      const list = train.filter((p) => p.next.position === position);
      byPosition.set(
        position,
        list.reduce((a, p) => a + p.next.concentration, 0) / Math.max(1, list.length),
      );
    }

    console.log(
      String(season).padEnd(9) + String(test.length).padStart(3) +
      spearman(test.map((p) => p.prev.concentration), actual).toFixed(3).padStart(15) +
      spearman(test.map((p) => predictRidge(weights, featureRow(p.prev))), actual).toFixed(3).padStart(13) +
      spearman(test.map((p) => byPosition.get(p.prev.position) ?? 0), actual).toFixed(3).padStart(27),
    );
  }

  // what the model does with the two players that started this
  const weights = fitRidge(
    pairs.map((p) => featureRow(p.prev)),
    pairs.map((p) => p.next.concentration),
    1,
  );
  console.log("\nspread of predicted concentration across 2025 receivers:");
  const preds = (bySeason.get(2025) ?? [])
    .filter((r) => r.position === "WR" && r.ppg >= 6)
    .map((r) => ({ id: r.id, p: predictRidge(weights, featureRow(r)) }))
    .sort((a, b) => a.p - b.p);
  console.log(
    "  lowest " + preds[0]!.p.toFixed(3) +
    "   median " + preds[Math.floor(preds.length / 2)]!.p.toFixed(3) +
    "   highest " + preds.at(-1)!.p.toFixed(3),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
