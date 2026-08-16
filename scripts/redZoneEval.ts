/**
 * Does a share of the chances to score predict next season's scoring
 * better than a share of last season's scores does?
 *
 * The generative model needs a touchdown share per player. It uses the
 * realised one, which is close to noise year over year. Chances inside
 * the twenty are a decision the coaches repeat weekly.
 *
 * Run: npx tsx scripts/redZoneEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { spearman } from "../src/backtest/metrics.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";

interface Row {
  season: number; player: string; team: string; position: string;
  scoreShare: number; chanceShare: number; goalShare: number; redTargetShare: number;
  chances: number;
}

async function main(): Promise<void> {
  const raw = parseCsv(
    await readFile(join(import.meta.dirname, "..", "data", "curated", "redZone.csv"), "utf8"),
  );
  const { loadPlayerStats } = await import("../src/data/nflverse.js");
  const rows: Row[] = [];

  for (const season of [2021, 2022, 2023, 2024, 2025]) {
    const positions = new Map<string, string>();

    for (const s of await loadPlayerStats(season)) {
      positions.set(s.playerId, s.position);
    }

    for (const r of raw.filter((x) => Number(x["season"]) === season)) {
      const share = (a: string, b: string) =>
        Number(r[b]) > 0 ? Number(r[a]) / Number(r[b]) : 0;
      const chances = Number(r["redTargets"]) + Number(r["redCarries"]);
      const position = positions.get(r["player"] ?? "") ?? "";

      if (!["RB", "WR", "TE"].includes(position)) {
        continue;
      }

      rows.push({
        season, player: r["player"] ?? "", team: r["team"] ?? "", position,
        scoreShare: share("scores", "teamScores"),
        chanceShare:
          (Number(r["redTargets"]) + Number(r["redCarries"])) /
          Math.max(1, Number(r["teamRedTargets"]) + Number(r["teamRedCarries"])),
        goalShare: share("goalCarries", "teamGoalCarries"),
        redTargetShare: share("redTargets", "teamRedTargets"),
        chances,
      });
    }
  }

  const byKey = new Map(rows.map((r) => [`${r.player}|${r.season}`, r]));
  const pairs: { prev: Row; next: Row }[] = [];

  for (const row of rows) {
    const prev = byKey.get(`${row.player}|${row.season - 1}`);

    if (prev && prev.position === row.position && prev.chances >= 8 && row.chances >= 8) {
      pairs.push({ prev, next: row });
    }
  }

  console.log(`${pairs.length} player-season pairs with real red-zone use\n`);
  console.log("predicting next season's share of his team's touchdowns\n");
  console.log("position    n   last year's scores   chances inside 20   goal-line carries   red-zone targets");

  for (const position of ["RB", "WR", "TE", "all"]) {
    const sub = position === "all"
      ? pairs
      : pairs.filter((p) => p.prev.position === position);

    if (sub.length < 30) continue;

    const target = sub.map((p) => p.next.scoreShare);
    const score = (get: (r: Row) => number) =>
      spearman(sub.map((p) => get(p.prev)), target).toFixed(3);

    console.log(
      position.padEnd(8) + String(sub.length).padStart(5) +
      score((r) => r.scoreShare).padStart(20) +
      score((r) => r.chanceShare).padStart(20) +
      score((r) => r.goalShare).padStart(20) +
      score((r) => r.redTargetShare).padStart(19),
    );
  }

  await combined(pairs);
}

async function combined(pairs: { prev: Row; next: Row }[]): Promise<void> {
  console.log("\ncombining them, trained on earlier seasons and scored on the next\n");
  console.log("position    n   best single   all four together");

  const row = (r: Row) => [
    1, r.scoreShare, r.chanceShare, r.goalShare, r.redTargetShare,
  ];

  for (const position of ["RB", "WR", "TE"]) {
    const sub = pairs.filter((p) => p.prev.position === position);
    const train = sub.filter((p) => p.next.season < 2025);
    const test = sub.filter((p) => p.next.season === 2025);

    if (train.length < 40 || test.length < 15) continue;

    const weights = fitRidge(
      train.map((p) => row(p.prev)), train.map((p) => p.next.scoreShare), 0.02,
    );
    const target = test.map((p) => p.next.scoreShare);
    const singles = [
      spearman(test.map((p) => p.prev.scoreShare), target),
      spearman(test.map((p) => p.prev.chanceShare), target),
      spearman(test.map((p) => p.prev.goalShare), target),
      spearman(test.map((p) => p.prev.redTargetShare), target),
    ];

    console.log(
      position.padEnd(8) + String(test.length).padStart(5) +
      Math.max(...singles).toFixed(3).padStart(14) +
      spearman(test.map((p) => predictRidge(weights, row(p.prev))), target)
        .toFixed(3).padStart(20),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
