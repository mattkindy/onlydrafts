/**
 * Splitting usage by situation costs sample size, so it has to buy
 * something. Two checks: does a man's share in a situation carry over
 * to the next season, and does it say something his overall share does
 * not already say?
 *
 * Run: npx tsx scripts/situationEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { spearman } from "../src/backtest/metrics.js";

interface Use {
  season: number; player: string; situation: string;
  share: number; touches: number; scoreRate: number; yardsPerTouch: number;
}

async function main(): Promise<void> {
  const raw = parseCsv(
    await readFile(join(import.meta.dirname, "..", "data", "curated", "situations.csv"), "utf8"),
  );
  const uses: Use[] = raw.map((r) => ({
    season: Number(r["season"]),
    player: r["player"] ?? "",
    situation: r["situation"] ?? "",
    share: Number(r["touches"]) / Math.max(1, Number(r["teamPlays"])),
    touches: Number(r["touches"]),
    scoreRate: Number(r["scores"]) / Math.max(1, Number(r["touches"])),
    yardsPerTouch: Number(r["yards"]) / Math.max(1, Number(r["touches"])),
  }));

  const byKey = new Map(uses.map((u) => [`${u.player}|${u.season}|${u.situation}`, u]));

  // a man's overall share, to see what the split adds beyond it
  const overall = new Map<string, number>();
  const totals = new Map<string, { touches: number; plays: number }>();

  for (const r of raw) {
    const key = `${r["player"]}|${r["season"]}`;
    const t = totals.get(key) ?? { touches: 0, plays: 0 };
    t.touches += Number(r["touches"]);
    t.plays += Number(r["teamPlays"]);
    totals.set(key, t);
  }

  for (const [key, t] of totals) {
    overall.set(key, t.touches / Math.max(1, t.plays));
  }

  const situations = [...new Set(uses.map((u) => u.situation))];
  console.log("does his share in a situation come back next season?\n");
  console.log("situation           n    his own share   his overall share   scoring rate");

  for (const situation of situations) {
    const pairs: { prev: Use; next: Use }[] = [];

    for (const use of uses.filter((u) => u.situation === situation)) {
      const prev = byKey.get(`${use.player}|${use.season - 1}|${situation}`);

      if (prev && prev.touches >= 8 && use.touches >= 8) {
        pairs.push({ prev, next: use });
      }
    }

    if (pairs.length < 40) continue;

    const target = pairs.map((p) => p.next.share);
    console.log(
      situation.padEnd(20) + String(pairs.length).padStart(4) +
      spearman(pairs.map((p) => p.prev.share), target).toFixed(3).padStart(16) +
      spearman(
        pairs.map((p) => overall.get(`${p.prev.player}|${p.prev.season}`) ?? 0), target,
      ).toFixed(3).padStart(20) +
      spearman(
        pairs.map((p) => p.prev.scoreRate), pairs.map((p) => p.next.scoreRate),
      ).toFixed(3).padStart(15),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
