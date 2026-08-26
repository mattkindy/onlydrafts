/**
 * What can be said about a man who has never played.
 *
 * The joint parts model needs a season behind it, so it says nothing
 * about a rookie, and the regression keeps its seat partly to cover
 * them. This asks what a rookie season can be predicted from at all:
 * where he was taken, what his position is, and how many touches the
 * share model expects him to win.
 *
 * Run: npx tsx scripts/rookieEval.ts
 */

import { parseCsv } from "../src/data/csv.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import { rmse, spearman } from "../src/backtest/metrics.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SEASONS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
const FIT_ON = SEASONS.slice(0, 5);
const CHECK_ON = SEASONS.slice(5);
const RULES = presets.ppr;
const POSITIONS = ["QB", "RB", "WR", "TE"];

const picks = parseCsv(await readFile(
  join(import.meta.dirname, "..", "data", "raw", "draft_picks.csv"), "utf8"));

interface Rookie {
  season: number;
  who: string;
  position: string;
  round: number;
  pick: number;
  points: number;
  games: number;
}

const drafted = new Map<string, { season: number; round: number; pick: number; position: string }>();

for (const r of picks) {
  const who = r["gsis_id"] ?? "";
  const season = Number(r["season"]);
  const position = r["position"] ?? "";

  if (!who || !SEASONS.includes(season) || !POSITIONS.includes(position)) {
    continue;
  }

  drafted.set(who, {
    season, position,
    round: Number(r["round"]) || 8,
    pick: Number(r["pick"]) || 260,
  });
}

const rookies: Rookie[] = [];

for (const season of SEASONS) {
  const scored = new Map<string, { points: number; games: number }>();

  for (const s of await loadPlayerStats(season)) {
    if (s.week > 18) {
      continue;
    }

    const so = scored.get(s.playerId) ?? { points: 0, games: 0 };
    so.points += fantasyPoints(s.statLine, RULES);
    so.games++;
    scored.set(s.playerId, so);
  }

  for (const [who, his] of scored) {
    const pick = drafted.get(who);

    // his first season is the one he was taken in
    if (!pick || pick.season !== season || his.games < 4) {
      continue;
    }

    rookies.push({
      season, who, position: pick.position,
      round: pick.round, pick: pick.pick,
      points: his.points, games: his.games,
    });
  }
}

/**
 * Where he went, as something a fit can use. The value of a pick falls
 * away fast rather than evenly, so this is the log of it.
 */
const columnsFor = (r: Rookie) => [
  1,
  Math.log(r.pick) / Math.log(260),
  r.position === "RB" ? 1 : 0,
  r.position === "WR" ? 1 : 0,
  r.position === "TE" ? 1 : 0,
  r.position === "QB" ? 1 : 0,
];

const learn = rookies.filter((r) => FIT_ON.includes(r.season));
const check = rookies.filter((r) => CHECK_ON.includes(r.season));

console.log(`${rookies.length} rookies who played four games or more.`);
console.log(`Fitted on ${FIT_ON[0]} to ${FIT_ON.at(-1)}, marked on ${CHECK_ON[0]} to ${CHECK_ON.at(-1)}.\n`);

const weights = fitRidge(
  learn.map(columnsFor), learn.map((r) => r.points / r.games), 0.5,
);

const said = check.map((r) => Math.max(0, predictRidge(weights, columnsFor(r))));
const was = check.map((r) => r.points / r.games);

console.log("Predicting a rookie's points a game from where he was taken:\n");
console.log(`  error ${rmse(said, was).toFixed(2)}, order ${spearman(said, was).toFixed(3)}, over ${check.length} men`);

/** what each position's rookies averaged, as the least a model may do */
const flat = new Map<string, number>();

for (const position of POSITIONS) {
  const its = learn.filter((r) => r.position === position);
  flat.set(position, its.reduce((s, r) => s + r.points / r.games, 0) / Math.max(1, its.length));
}

const bland = check.map((r) => flat.get(r.position) ?? 0);
console.log(`  against knowing only his position: error ${rmse(bland, was).toFixed(2)}, order ${spearman(bland, was).toFixed(3)}`);

console.log("\nBy where he went, what rookies actually did:\n");
console.log("            n   points a game   played");

for (const [name, wants] of [
  ["first round", (r: Rookie) => r.round === 1],
  ["second", (r: Rookie) => r.round === 2],
  ["third", (r: Rookie) => r.round === 3],
  ["fourth on", (r: Rookie) => r.round >= 4],
] as [string, (r: Rookie) => boolean][]) {
  const its = rookies.filter(wants);

  if (its.length === 0) {
    continue;
  }

  const mean = its.reduce((s, r) => s + r.points / r.games, 0) / its.length;
  const games = its.reduce((s, r) => s + r.games, 0) / its.length;
  console.log(
    `  ${name.padEnd(12)} ${String(its.length).padStart(3)}   ` +
    `${mean.toFixed(2).padStart(11)}   ${games.toFixed(1).padStart(6)}`,
  );
}

console.log("\nAnd by position, first rounders only:\n");

for (const position of POSITIONS) {
  const its = rookies.filter((r) => r.round === 1 && r.position === position);

  if (its.length < 5) {
    continue;
  }

  const mean = its.reduce((s, r) => s + r.points / r.games, 0) / its.length;
  const best = [...its].sort((a, b) => b.points / b.games - a.points / a.games)[0]!;
  console.log(
    `  ${position.padEnd(4)} ${String(its.length).padStart(3)} men, ` +
    `${mean.toFixed(2)} a game, best ${(best.points / best.games).toFixed(1)}`,
  );
}
