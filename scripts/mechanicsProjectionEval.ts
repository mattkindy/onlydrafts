/**
 * Projecting a man from the parts of his play against projecting him
 * from what those parts came to.
 *
 * Both get exactly the same evidence, one prior season, so the only
 * difference is whether the parts were added up before or after being
 * pulled back toward the league.
 *
 * Run: npx tsx scripts/mechanicsProjectionEval.ts
 */

import { parseCsv } from "../src/data/csv.js";
import {
  projectFromMechanics, KEEPS,
  type Receiving, type Running, type League,
} from "../src/features/mechanicsProjection.js";
import { rmse, spearman } from "../src/backtest/metrics.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SEASONS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
type Row = Record<string, string>;
const n = (r: Row, key: string) => Number(r[key]) || 0;

const recRows = parseCsv(await readFile(
  join(import.meta.dirname, "..", "data", "raw", "advstats_rec.csv"), "utf8"));
const rushRows = parseCsv(await readFile(
  join(import.meta.dirname, "..", "data", "raw", "advstats_rush.csv"), "utf8"));

interface Man {
  who: string;
  position: string;
  games: number;
  receiving: Receiving;
  running: Running;
}

const bySeason = new Map<number, Map<string, Man>>();

const blankMan = (who: string, position: string): Man => ({
  who, position, games: 0,
  receiving: { games: 0, targets: 0, receptions: 0, beforeCatch: 0, afterCatch: 0, drops: 0 },
  running: { games: 0, carries: 0, beforeContact: 0, afterContact: 0 },
});

for (const r of recRows) {
  const season = Number(r["season"]);
  const who = r["pfr_id"] ?? "";

  if (!SEASONS.includes(season) || !who) {
    continue;
  }

  const table = bySeason.get(season) ?? new Map<string, Man>();
  const man = table.get(who) ?? blankMan(who, r["pos"] ?? "");
  man.position = r["pos"] ?? man.position;
  man.games = Math.max(man.games, n(r, "g"));
  man.receiving = {
    games: n(r, "g"),
    targets: n(r, "tgt"),
    receptions: n(r, "rec"),
    // the file gives these per catch, and the model wants the totals
    beforeCatch: n(r, "ybc"),
    afterCatch: n(r, "yac"),
    drops: n(r, "drop"),
  };
  table.set(who, man);
  bySeason.set(season, table);
}

for (const r of rushRows) {
  const season = Number(r["season"]);
  const who = r["pfr_id"] ?? "";

  if (!SEASONS.includes(season) || !who) {
    continue;
  }

  const table = bySeason.get(season) ?? new Map<string, Man>();
  const man = table.get(who) ?? blankMan(who, r["pos"] ?? "");
  man.position = r["pos"] ?? man.position;
  man.games = Math.max(man.games, n(r, "g"));
  man.running = {
    games: n(r, "g"),
    carries: n(r, "att"),
    beforeContact: n(r, "ybc"),
    afterContact: n(r, "yac"),
  };
  table.set(who, man);
  bySeason.set(season, table);
}

/** what everyone at a position did that season */
function leagueIn(season: number, position: string): League {
  const its = [...(bySeason.get(season)?.values() ?? [])]
    .filter((m) => m.position === position);
  const add = (of: (m: Man) => number) => its.reduce((s, m) => s + of(m), 0);

  return {
    receiving: {
      targets: add((m) => m.receiving.targets) / Math.max(1, its.length),
      receptions: add((m) => m.receiving.receptions) / Math.max(1, its.length),
      beforeCatch: add((m) => m.receiving.beforeCatch) / Math.max(1, its.length),
      afterCatch: add((m) => m.receiving.afterCatch) / Math.max(1, its.length),
      drops: add((m) => m.receiving.drops) / Math.max(1, its.length),
    },
    running: {
      carries: add((m) => m.running.carries) / Math.max(1, its.length),
      beforeContact: add((m) => m.running.beforeContact) / Math.max(1, its.length),
      afterContact: add((m) => m.running.afterContact) / Math.max(1, its.length),
    },
  };
}

/**
 * The same thing done to the total instead of the parts: his yards a
 * game pulled back toward his position by however much yards a game
 * keeps, which is what a projection on totals amounts to.
 */
const WHOLE_KEEPS = { recYds: 0.62, rushYds: 0.60 };

function projectWhole(
  man: Man, league: League, which: "recYds" | "rushYds",
): number {
  const his = which === "recYds"
    ? (man.receiving.beforeCatch + man.receiving.afterCatch) /
      Math.max(1, man.receiving.games)
    : (man.running.beforeContact + man.running.afterContact) /
      Math.max(1, man.running.games);
  const theirs = which === "recYds"
    ? (league.receiving.beforeCatch + league.receiving.afterCatch) / 17
    : (league.running.beforeContact + league.running.afterContact) / 17;
  const evidence = which === "recYds" ? man.receiving.targets : man.running.carries;
  const settlesAt = which === "recYds" ? 70 : 110;
  const trust = evidence / (evidence + settlesAt);

  return theirs + WHOLE_KEEPS[which] * trust * (his - theirs);
}

interface Pair { parts: number; whole: number; was: number }

console.log("Projecting next season from one prior season, per game.");
console.log("The parts pulled back one at a time against the total pulled");
console.log("back in one go. Lower error and higher order are better.\n");
console.log("            n      parts        whole      parts    whole");
console.log("                   error        error      order    order");

for (const [which, position, enough] of [
  ["recYds", "WR", 45], ["recYds", "TE", 30], ["recYds", "RB", 25],
  ["rushYds", "RB", 80],
] as ["recYds" | "rushYds", string, number][]) {
  const pairs: Pair[] = [];

  for (let i = 1; i < SEASONS.length; i++) {
    const before = bySeason.get(SEASONS[i - 1]!);
    const after = bySeason.get(SEASONS[i]!);

    if (!before || !after) {
      continue;
    }

    const league = leagueIn(SEASONS[i - 1]!, position);

    for (const [who, man] of before) {
      const next = after.get(who);
      const evidence = which === "recYds" ? man.receiving.targets : man.running.carries;

      if (!next || man.position !== position || evidence < enough ||
          next.games < 6) {
        continue;
      }

      const said = projectFromMechanics(man.receiving, man.running, league);
      const was = which === "recYds"
        ? (next.receiving.beforeCatch + next.receiving.afterCatch) /
          Math.max(1, next.receiving.games)
        : (next.running.beforeContact + next.running.afterContact) /
          Math.max(1, next.running.games);

      pairs.push({
        parts: said[which],
        whole: projectWhole(man, league, which),
        was,
      });
    }
  }

  if (pairs.length < 25) {
    console.log(`  ${which} ${position}  too few (${pairs.length})`);
    continue;
  }

  const was = pairs.map((p) => p.was);
  const label = `${which === "recYds" ? "rec yds" : "rush yds"} ${position}`;

  console.log(
    `  ${label.padEnd(12)} ${String(pairs.length).padStart(4)}  ` +
    `${rmse(pairs.map((p) => p.parts), was).toFixed(3).padStart(9)}  ` +
    `${rmse(pairs.map((p) => p.whole), was).toFixed(3).padStart(9)}  ` +
    `${spearman(pairs.map((p) => p.parts), was).toFixed(3).padStart(8)}  ` +
    `${spearman(pairs.map((p) => p.whole), was).toFixed(3).padStart(7)}`,
  );
}

console.log("\nwhat each part keeps, which is the whole idea:");
for (const [part, keeps] of Object.entries(KEEPS)) {
  console.log(`  ${part.padEnd(16)} ${keeps.toFixed(3)}`);
}
