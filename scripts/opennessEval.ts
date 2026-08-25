/**
 * Does getting open explain both how often a man is thrown at and what
 * he does with it?
 *
 * There is no tracking data here, so no separation. The nearest thing
 * is completion over expected: the play by play gives a completion
 * probability for every throw, and how much a receiver beats it is
 * mostly him being open when the ball arrives.
 *
 * Run: npx tsx scripts/opennessEval.ts
 */

import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { RAW_DIR } from "../src/data/nflverse.js";
import { splitLine } from "../src/data/csv.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";

const SEASONS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];

interface Tally {
  targets: number;
  complete: number;
  /** what the model gave the throw before it was made */
  expected: number;
  yards: number;
  air: number;
  games: Set<string>;
}

const bySeason = new Map<number, Map<string, Tally>>();

for (const season of SEASONS) {
  const path = join(RAW_DIR, `play_by_play_${season}.csv`);

  if (!existsSync(path)) {
    continue;
  }

  const table = new Map<string, Tally>();
  const reader = createInterface({ input: createReadStream(path) });
  let header: string[] | undefined;
  const at: Record<string, number> = {};

  for await (const line of reader) {
    if (!header) {
      header = splitLine(line);

      for (const field of [
        "play_type", "receiver_player_id", "complete_pass", "cp",
        "receiving_yards", "air_yards", "game_id", "season_type", "two_point_attempt",
      ]) {
        at[field] = header.indexOf(field);
      }

      continue;
    }

    const c = splitLine(line);

    if (c[at["play_type"]!] !== "pass" || c[at["season_type"]!] !== "REG" ||
        c[at["two_point_attempt"]!] === "1") {
      continue;
    }

    const who = c[at["receiver_player_id"]!] ?? "";
    const expected = Number(c[at["cp"]!]);

    // a throw with nobody named on it is a sack or a ball away, and a
    // throw the model would not price has nothing to beat
    if (!who || !Number.isFinite(expected)) {
      continue;
    }

    const so = table.get(who) ?? {
      targets: 0, complete: 0, expected: 0, yards: 0, air: 0, games: new Set<string>(),
    };
    so.targets++;
    so.complete += c[at["complete_pass"]!] === "1" ? 1 : 0;
    so.expected += expected;
    so.yards += Number(c[at["receiving_yards"]!]) || 0;
    so.air += Number(c[at["air_yards"]!]) || 0;
    so.games.add(c[at["game_id"]!] ?? "");
    table.set(who, so);
  }

  bySeason.set(season, table);
  console.log(`${season}: ${table.size} men thrown at`);
}

const ENOUGH = 40;

interface Pair {
  wasOpen: number;
  wasPerGame: number;
  wasPerTarget: number;
  nowPerGame: number;
  nowPerTarget: number;
}

const pairs: Pair[] = [];

for (let i = 1; i < SEASONS.length; i++) {
  const before = bySeason.get(SEASONS[i - 1]!);
  const after = bySeason.get(SEASONS[i]!);

  if (!before || !after) {
    continue;
  }

  const levelIn = (t: Map<string, Tally>) => {
    const its = [...t.values()].filter((s) => s.targets >= ENOUGH);
    const mean = (of: (s: Tally) => number) =>
      its.reduce((sum, s) => sum + of(s), 0) / Math.max(1, its.length);

    return {
      perGame: mean((s) => s.targets / s.games.size),
      perTarget: mean((s) => s.yards / s.targets),
    };
  };
  const was = levelIn(before);
  const now = levelIn(after);

  for (const [who, a] of before) {
    const b = after.get(who);

    if (!b || a.targets < ENOUGH || b.targets < ENOUGH) {
      continue;
    }

    pairs.push({
      // how much more often the ball arrived than the throw deserved
      wasOpen: (a.complete - a.expected) / a.targets,
      wasPerGame: a.targets / a.games.size / was.perGame - 1,
      wasPerTarget: a.yards / a.targets / was.perTarget - 1,
      nowPerGame: b.targets / b.games.size / now.perGame - 1,
      nowPerTarget: b.yards / b.targets / now.perTarget - 1,
    });
  }
}

function explains(
  target: (p: Pair) => number, columns: ((p: Pair) => number)[],
): number {
  const y = pairs.map(target);
  const design = pairs.map((p) => [1, ...columns.map((of) => of(p))]);
  const weights = fitRidge(design, y, 0.01);
  const said = design.map((r) => predictRidge(weights, r));
  const mean = y.reduce((s, v) => s + v, 0) / y.length;
  const total = y.reduce((s, v) => s + (v - mean) ** 2, 0);
  const left = y.reduce((s, v, i) => s + (v - said[i]!) ** 2, 0);

  return total > 0 ? 1 - left / total : 0;
}

const open = (p: Pair) => p.wasOpen;
const perGame = (p: Pair) => p.wasPerGame;
const perTarget = (p: Pair) => p.wasPerTarget;

console.log(`\n${pairs.length} pairs of seasons, ${ENOUGH}+ targets in both.\n`);
console.log("How much of next season each version explains:\n");

console.log("  next targets a game");
console.log(`    from how often he was thrown at        ${explains((p) => p.nowPerGame, [perGame]).toFixed(3)}`);
console.log(`    from how open he was                   ${explains((p) => p.nowPerGame, [open]).toFixed(3)}`);
console.log(`    from both                              ${explains((p) => p.nowPerGame, [perGame, open]).toFixed(3)}`);
console.log(`    and his yards a target too             ${explains((p) => p.nowPerGame, [perGame, open, perTarget]).toFixed(3)}`);

console.log("\n  next yards a target");
console.log(`    from his own yards a target            ${explains((p) => p.nowPerTarget, [perTarget]).toFixed(3)}`);
console.log(`    from how open he was                   ${explains((p) => p.nowPerTarget, [open]).toFixed(3)}`);
console.log(`    from both                              ${explains((p) => p.nowPerTarget, [perTarget, open]).toFixed(3)}`);
console.log(`    and how often he was thrown at too     ${explains((p) => p.nowPerTarget, [perTarget, open, perGame]).toFixed(3)}`);

/** how much of one thing this season goes with the other */
const correlate = (a: (p: Pair) => number, b: (p: Pair) => number) => {
  const xs = pairs.map(a);
  const ys = pairs.map(b);
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let top = 0;
  let left = 0;
  let right = 0;

  for (let i = 0; i < xs.length; i++) {
    top += (xs[i]! - mx) * (ys[i]! - my);
    left += (xs[i]! - mx) ** 2;
    right += (ys[i]! - my) ** 2;
  }

  return top / Math.sqrt(left * right);
};

console.log("\nWithin one season, how much these go together:\n");
console.log(`  open and thrown at        ${correlate(open, perGame).toFixed(3)}`);
console.log(`  open and yards a target   ${correlate(open, perTarget).toFixed(3)}`);
console.log(`  thrown at and yards       ${correlate(perGame, perTarget).toFixed(3)}`);
