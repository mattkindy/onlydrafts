/**
 * One model over all of a man's parts, against pulling each part back
 * on its own, against pulling the total back.
 *
 * Volume and efficiency each say something about the other's future, so
 * a model that sees both at once should beat two that do not. Fitted on
 * the early seasons and marked on the later ones.
 *
 * Run: npx tsx scripts/jointProjectionEval.ts
 */

import { parseCsv } from "../src/data/csv.js";
import {
  projectFromMechanics, type Receiving, type Running, type League,
} from "../src/features/mechanicsProjection.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import { rmse, spearman, caught, gain } from "../src/backtest/metrics.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const FIT_ON = [2018, 2019, 2020, 2021];
const TEST_ON = [2022, 2023, 2024];
const SEASONS = [...FIT_ON, ...TEST_ON, 2025];

type Row = Record<string, string>;
const n = (r: Row, key: string) => Number(r[key]) || 0;

const recRows = parseCsv(await readFile(
  join(import.meta.dirname, "..", "data", "raw", "advstats_rec.csv"), "utf8"));
const rushRows = parseCsv(await readFile(
  join(import.meta.dirname, "..", "data", "raw", "advstats_rush.csv"), "utf8"));

interface Man {
  position: string;
  age: number;
  receiving: Receiving;
  running: Running;
}

const blank = (position: string): Man => ({
  position, age: 0,
  receiving: { games: 0, targets: 0, receptions: 0, beforeCatch: 0, afterCatch: 0, drops: 0 },
  running: { games: 0, carries: 0, beforeContact: 0, afterContact: 0 },
});

const bySeason = new Map<number, Map<string, Man>>();

for (const [rows, which] of [[recRows, "rec"], [rushRows, "rush"]] as [Row[], string][]) {
  for (const r of rows) {
    const season = Number(r["season"]);
    const who = r["pfr_id"] ?? "";

    if (!SEASONS.includes(season) || !who) {
      continue;
    }

    const table = bySeason.get(season) ?? new Map<string, Man>();
    const man = table.get(who) ?? blank(r["pos"] ?? "");
    man.position = r["pos"] ?? man.position;
    man.age = n(r, "age") || man.age;

    if (which === "rec") {
      man.receiving = {
        games: n(r, "g"), targets: n(r, "tgt"), receptions: n(r, "rec"),
        beforeCatch: n(r, "ybc"), afterCatch: n(r, "yac"), drops: n(r, "drop"),
      };
    } else {
      man.running = {
        games: n(r, "g"), carries: n(r, "att"),
        beforeContact: n(r, "ybc"), afterContact: n(r, "yac"),
      };
    }

    table.set(who, man);
    bySeason.set(season, table);
  }
}

function leagueIn(season: number, position: string): League {
  const its = [...(bySeason.get(season)?.values() ?? [])]
    .filter((m) => m.position === position);
  const mean = (of: (m: Man) => number) =>
    its.reduce((s, m) => s + of(m), 0) / Math.max(1, its.length);

  return {
    receiving: {
      targets: mean((m) => m.receiving.targets),
      receptions: mean((m) => m.receiving.receptions),
      beforeCatch: mean((m) => m.receiving.beforeCatch),
      afterCatch: mean((m) => m.receiving.afterCatch),
      drops: mean((m) => m.receiving.drops),
    },
    running: {
      carries: mean((m) => m.running.carries),
      beforeContact: mean((m) => m.running.beforeContact),
      afterContact: mean((m) => m.running.afterContact),
    },
  };
}

const per = (top: number, bottom: number) => (bottom > 0 ? top / bottom : 0);

/** everything one season says about him, for a model that sees it all at once */
function columns(man: Man): number[] {
  const r = man.receiving;
  const g = Math.max(1, r.games);

  return [
    1,
    per(r.targets, g),
    per(r.receptions, g),
    per(r.beforeCatch + r.afterCatch, g),
    per(r.receptions, r.targets),
    per(r.beforeCatch, r.receptions),
    per(r.afterCatch, r.receptions),
    per(r.drops, r.targets),
    per(man.running.carries, Math.max(1, man.running.games)),
    man.age / 30,
    Math.min(17, r.games) / 17,
  ];
}

const recYdsPerGame = (man: Man) =>
  per(man.receiving.beforeCatch + man.receiving.afterCatch, Math.max(1, man.receiving.games));

const WHOLE_KEEPS = 0.62;

function projectWhole(man: Man, league: League): number {
  const his = recYdsPerGame(man);
  const theirs = (league.receiving.beforeCatch + league.receiving.afterCatch) / 17;
  const trust = man.receiving.targets / (man.receiving.targets + 70);

  return theirs + WHOLE_KEEPS * trust * (his - theirs);
}

interface Case {
  columns: number[];
  parts: number;
  whole: number;
  was: number;
}

function casesIn(seasons: number[], position: string, enough: number): Case[] {
  const out: Case[] = [];

  for (const season of seasons) {
    const before = bySeason.get(season);
    const after = bySeason.get(season + 1);

    if (!before || !after) {
      continue;
    }

    const league = leagueIn(season, position);

    for (const [who, man] of before) {
      const next = after.get(who);

      if (!next || man.position !== position ||
          man.receiving.targets < enough || next.receiving.games < 6) {
        continue;
      }

      out.push({
        columns: columns(man),
        parts: projectFromMechanics(man.receiving, man.running, league).recYds,
        whole: projectWhole(man, league),
        was: recYdsPerGame(next),
      });
    }
  }

  return out;
}

console.log("Receiving yards a game, next season from this one.");
console.log(`Fitted on ${FIT_ON.join(", ")} and marked on ${TEST_ON.join(", ")}.\n`);
console.log("              n     error    order   first 36   discounted");

for (const [position, enough] of [["WR", 45], ["TE", 30], ["RB", 25]] as [string, number][]) {
  const learn = casesIn(FIT_ON, position, enough);
  const test = casesIn(TEST_ON, position, enough);

  if (learn.length < 40 || test.length < 40) {
    console.log(`  ${position}: too few (${learn.length} learn, ${test.length} test)`);
    continue;
  }

  const weights = fitRidge(learn.map((c) => c.columns), learn.map((c) => c.was), 0.5);
  const was = test.map((c) => c.was);
  const said = {
    joint: test.map((c) => Math.max(0, predictRidge(weights, c.columns))),
    parts: test.map((c) => c.parts),
    whole: test.map((c) => c.whole),
  };

  console.log(`  ${position}, ${test.length} to mark`);

  for (const [name, values] of Object.entries(said)) {
    console.log(
      `    ${name.padEnd(9)} ${rmse(values, was).toFixed(3).padStart(8)}  ` +
      `${spearman(values, was).toFixed(3).padStart(7)}  ` +
      `${caught(values, was.map((v) => v - 30), 36).toFixed(3).padStart(8)}  ` +
      `${gain(values, was.map((v) => v - 30)).toFixed(3).padStart(10)}`,
    );
  }

  console.log("");
}
