/**
 * How well can anybody call a run from the situation?
 *
 * The walk misses the call by .2067 where saying the league rate every
 * time misses by .2450, and whether that is good is impossible to say
 * without knowing what is there to be had. So this fits a plain model
 * on the seasons before, on the same down, distance, field position,
 * score and clock the walk reads, and asks it the same plays.
 *
 * Run: npx tsx scripts/callCeilingEval.ts [season]
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";

const SEASON = Number(process.argv[2] ?? 2024);
const LEARN_ON = [SEASON - 3, SEASON - 2, SEASON - 1];

const raw = parseCsv(await readFile(
  join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
)).filter((r) => ["run", "pass"].includes(r["playType"] ?? ""));

interface Play {
  x: number[];
  run: number;
  down: number;
}

/**
 * What a coach is actually looking at. The steps matter more than the
 * levels, so each down is its own column and the distance it takes to
 * make comes in as its log as well.
 */
function featuresOf(r: Record<string, string | undefined>): Play | null {
  const down = Number(r["down"]);
  const toGo = Number(r["togo"]);
  const yardline = Number(r["yardline"]);
  const margin = Number(r["margin"]) || 0;
  const left = Number(r["seconds"]) || 1800;

  if (!Number.isFinite(down) || !Number.isFinite(toGo) ||
      !Number.isFinite(yardline) || down < 1 || down > 4) {
    return null;
  }

  const short = toGo <= 2 ? 1 : 0;
  const late = left < 300 ? 1 : 0;

  return {
    down,
    run: r["playType"] === "run" ? 1 : 0,
    x: [
      1,
      down === 1 ? 1 : 0, down === 2 ? 1 : 0, down === 3 ? 1 : 0,
      toGo / 10, Math.log(Math.max(1, toGo)),
      short, short * (down === 3 ? 1 : 0),
      yardline / 100, (yardline / 100) ** 2,
      yardline <= 5 ? 1 : 0, yardline <= 10 ? 1 : 0,
      margin / 14, Math.abs(margin) / 14,
      left / 1800, (left / 1800) ** 2,
      late, late * (margin < 0 ? 1 : 0),
      (margin / 14) * (left / 1800),
      (down === 3 ? 1 : 0) * (toGo / 10),
    ],
  };
}

const learn: Play[] = [];
const score: Play[] = [];

for (const r of raw) {
  const season = Number(r["season"]);
  const play = LEARN_ON.includes(season) || season === SEASON
    ? featuresOf(r)
    : null;

  if (!play) {
    continue;
  }

  (season === SEASON ? score : learn).push(play);
}

const fit = fitRidge(learn.map((p) => p.x), learn.map((p) => p.run), 1);
let ran = 0;

for (const p of learn) {
  ran += p.run;
}

const flat = ran / Math.max(1, learn.length);
let brier = 0;
let flatBrier = 0;
const byDown = new Map<number, { n: number; brier: number; flat: number }>();

for (const p of score) {
  const said = Math.max(0.01, Math.min(0.99, predictRidge(fit, p.x)));
  const off = (said - p.run) ** 2;
  brier += off;
  flatBrier += (flat - p.run) ** 2;
  const own = byDown.get(p.down) ?? { n: 0, brier: 0, flat: 0 };
  own.n++;
  own.brier += off;
  own.flat += (flat - p.run) ** 2;
  byDown.set(p.down, own);
}

console.log(
  `${SEASON}, ${score.length} plays, learned on ${learn.length} from ` +
  `${LEARN_ON.join(", ")}:\n` +
  `  a plain model misses by ${(brier / score.length).toFixed(4)}, ` +
  `the league rate by ${(flatBrier / score.length).toFixed(4)}\n` +
  `  (the walk misses these by .2067)`,
);

for (const down of [1, 2, 3, 4]) {
  const own = byDown.get(down);

  if (own && own.n > 200) {
    console.log(
      `    down ${down}  ${String(own.n).padStart(6)} plays  ` +
      `model ${(own.brier / own.n).toFixed(4)}  ` +
      `league rate ${(own.flat / own.n).toFixed(4)}`,
    );
  }
}
