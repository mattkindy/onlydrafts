/**
 * How much of the quarterback order the walk should set.
 *
 * The board's blend eval scores skill positions only, so the walk's
 * seat at quarterback has never been measured. This orders each
 * season's quarterbacks by a blend of the walk and adp at each
 * weight and scores the order against their season points.
 *
 * Run: npx tsx scripts/qbSeatEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spearman } from "../src/backtest/metrics.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { loadAdp } from "../src/data/adp.js";
import { normalizeName } from "../src/data/names.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";

const RULES = presets.standard;
const SEASONS = [2023, 2024, 2025];

async function qbsFor(season: number): Promise<
  { says: number; adp: number; points: number }[]
> {
  const kept = JSON.parse(await readFile(
    join(import.meta.dirname, "..", "data", "kept", `played-${season}.json`),
    "utf8",
  )) as { total: [string, number][] };
  const walkSays = new Map(kept.total);
  const names = new Map<string, string>();
  const positions = new Map<string, string>();
  const scored = new Map<string, number>();

  for (const s of await loadPlayerStats(season)) {
    if (s.week > 17) {
      continue;
    }

    names.set(s.playerId, s.playerName);
    positions.set(s.playerId, s.position);
    scored.set(
      s.playerId,
      (scored.get(s.playerId) ?? 0) + fantasyPoints(s.statLine, RULES),
    );
  }

  const adp = await loadAdp(season, "ppr").catch(() => new Map());

  return [...walkSays.entries()]
    .filter(([id]) => positions.get(id) === "QB")
    .map(([id, says]) => ({
      says,
      adp: adp.get(`${normalizeName(names.get(id) ?? "")}|QB`)?.adp ?? null,
      points: scored.get(id) ?? 0,
    }))
    .filter((m): m is { says: number; adp: number; points: number } =>
      m.adp !== null);
}

function placeOf(values: number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
  const out = new Array<number>(values.length);
  order.forEach((row, rank) => { out[row.i] = rank + 1; });

  return out;
}

async function main(): Promise<void> {
  const bySeason = new Map<number, number[]>();

  for (const season of SEASONS) {
    const men = await qbsFor(season);
    const walk = placeOf(men.map((m) => m.says));
    const room = placeOf(men.map((m) => -m.adp));
    const points = men.map((m) => m.points);
    const scores: number[] = [];

    for (const onWalk of [0, 0.15, 0.3, 0.5, 0.7, 0.85, 1]) {
      scores.push(spearman(
        men.map((_, i) => -(onWalk * walk[i]! + (1 - onWalk) * room[i]!)),
        points,
      ));
    }

    bySeason.set(season, scores);
  }

  console.log("the walk's seat in the quarterback order, against adp");
  console.log("seat      " + SEASONS.map((s) => String(s).padStart(7)).join("") +
    "  average");

  [0, 0.15, 0.3, 0.5, 0.7, 0.85, 1].forEach((onWalk, k) => {
    const row = SEASONS.map((s) => bySeason.get(s)![k]!);
    const line = row.map((v) => v.toFixed(3).padStart(7)).join("");
    const average = row.reduce((a, b) => a + b, 0) / row.length;
    console.log(
      `${(100 * onWalk).toFixed(0).padStart(3)}%      ${line}` +
        `  ${average.toFixed(3)}`,
    );
  });
}

await main();
