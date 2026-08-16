/*
 * Refits the weights in src/features/restOfSeason.ts.
 * Run: npx tsx scripts/reprojectEval.ts
 *
 * Once a season is running, how much should the weeks you have seen
 * outweigh the preseason projection when you predict the weeks that
 * are left? Fit the weight at every cut point, training only on
 * earlier seasons.
 */
import {
  buildSeasonData, examplesForTransition, fitSeasonModel, predictSeasonBlend,
} from "../src/features/seasonModel.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";

function spearman(a: number[], b: number[]): number {
  const rank = (xs: number[]) => {
    const o = xs.map((x, i) => [x, i] as [number, number]).sort((p, q) => p[0] - q[0]);
    const r = new Array<number>(xs.length);
    o.forEach(([, i], k) => { r[i] = k; });
    return r;
  };
  const ra = rank(a), rb = rank(b), n = a.length, mu = (n - 1) / 2;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i]! - mu) * (rb[i]! - mu);
    da += (ra[i]! - mu) ** 2; db += (rb[i]! - mu) ** 2;
  }
  return num / Math.sqrt(da * db);
}

const rmse = (a: number[], b: number[]) =>
  Math.sqrt(a.reduce((s, x, i) => s + (x - b[i]!) ** 2, 0) / a.length);

const CUTS = [2, 4, 6, 8, 10, 12];

async function main() {
  const seasons = [2021, 2022, 2023, 2024, 2025];
  const data = await buildSeasonData(seasons);
  const rows: { cut: number; pre: number; toDate: number; rest: number }[] = [];

  for (const target of [2023, 2024, 2025]) {
    const train: Awaited<ReturnType<typeof examplesForTransition>> = [];

    for (const s of seasons.filter((s) => s > 2021 && s < target)) {
      train.push(...(await examplesForTransition(s, data)));
    }

    if (!train.length) continue;

    const fit = fitSeasonModel(train);
    const examples = await examplesForTransition(target, data);
    const preById = new Map(examples.map((e) => [e.playerId, predictSeasonBlend(fit, e)]));
    const weeks = await loadPlayerStats(target);
    const byPlayer = new Map<string, { week: number; pts: number }[]>();

    for (const w of weeks) {
      if (!["QB", "RB", "WR", "TE"].includes(w.position)) continue;
      const list = byPlayer.get(w.playerId) ?? [];
      list.push({ week: w.week, pts: fantasyPoints(w.statLine, presets.standard) });
      byPlayer.set(w.playerId, list);
    }

    for (const [id, list] of byPlayer) {
      const pre = preById.get(id);
      if (pre === undefined) continue;
      list.sort((a, b) => a.week - b.week);

      for (const cut of CUTS) {
        const seen = list.filter((g) => g.week <= cut);
        const rest = list.filter((g) => g.week > cut);
        if (seen.length < Math.max(2, cut - 2) || rest.length < 4) continue;
        rows.push({
          cut, pre,
          toDate: seen.reduce((a, g) => a + g.pts, 0) / seen.length,
          rest: rest.reduce((a, g) => a + g.pts, 0) / rest.length,
        });
      }
    }
  }

  console.log("predicting the rest of the season, " + rows.length + " player-cuts\n");
  console.log("after   n     preseason   to date   best mix   weight on to-date   rmse");

  for (const cut of CUTS) {
    const sub = rows.filter((r) => r.cut === cut);
    if (sub.length < 50) continue;
    const rest = sub.map((r) => r.rest);
    let best = { w: 0, s: -Infinity };

    for (let w = 0; w <= 1.0001; w += 0.05) {
      const s = spearman(sub.map((r) => (1 - w) * r.pre + w * r.toDate), rest);
      if (s > best.s) best = { w, s };
    }

    console.log(
      ("week " + cut).padEnd(8) + String(sub.length).padStart(5) +
      spearman(sub.map((r) => r.pre), rest).toFixed(3).padStart(12) +
      spearman(sub.map((r) => r.toDate), rest).toFixed(3).padStart(10) +
      best.s.toFixed(3).padStart(11) +
      best.w.toFixed(2).padStart(20) +
      rmse(sub.map((r) => (1 - best.w) * r.pre + best.w * r.toDate), rest).toFixed(2).padStart(7));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
