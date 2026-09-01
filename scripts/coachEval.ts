/**
 * Whether a defence repeats because of who is coaching it.
 *
 * A side is players and a coach, and the players came back null:
 * continuity of snaps did not explain which defences repeat. If the
 * coach is the missing term, a side that keeps him should repeat better
 * than one that changed, and a coach who moves should take something
 * with him.
 *
 * No defensive coordinator exists across seasons here, so the head
 * coach stands in. Every game says who it was, which handles a man
 * sacked in November.
 *
 * Run: npx tsx scripts/coachEval.ts
 */

import { readFileSync } from "node:fs";

import { parseCsv } from "../src/data/csv.js";

const num = (row: Record<string, string>, key: string) =>
  Number(row[key] ?? 0) || 0;

const mean = (its: number[]) =>
  its.length ? its.reduce((s, n) => s + n, 0) / its.length : 0;

function correlation(pairs: [number, number][]): number {
  const xs = pairs.map(([x]) => x);
  const ys = pairs.map(([, y]) => y);
  const mx = mean(xs);
  const my = mean(ys);
  const top = pairs.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0);
  const left = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0));
  const right = Math.sqrt(ys.reduce((s, y) => s + (y - my) ** 2, 0));

  return left && right ? top / (left * right) : 0;
}

const games = parseCsv(readFileSync("data/raw/games.csv", "utf8"));

interface TeamYear {
  allowed: number[];
  coaches: string[];
}

const years = new Map<string, TeamYear>();

for (const g of games) {
  if (!g["home_score"] || Number(g["week"]) > 18 || g["game_type"] !== "REG") {
    continue;
  }

  const season = Number(g["season"]);

  if (season < 2015 || season > 2025) {
    continue;
  }

  const put = (team: string, gave: number, coach: string) => {
    const key = `${season}|${team}`;
    const its = years.get(key) ?? { allowed: [], coaches: [] };
    its.allowed.push(gave);
    its.coaches.push(coach);
    years.set(key, its);
  };

  put(g["home_team"]!, num(g, "away_score"), g["home_coach"] ?? "");
  put(g["away_team"]!, num(g, "home_score"), g["away_coach"] ?? "");
}

/** whoever took most of the games, so a man sacked in week ten does not win */
const inCharge = (its: TeamYear) => {
  const tally = new Map<string, number>();

  for (const who of its.coaches) {
    tally.set(who, (tally.get(who) ?? 0) + 1);
  }

  return [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
};

const stayed: [number, number][] = [];
const changed: [number, number][] = [];

for (let season = 2016; season <= 2025; season++) {
  for (const [key, now] of years) {
    const [was, team] = key.split("|");

    if (Number(was) !== season) {
      continue;
    }

    const before = years.get(`${season - 1}|${team}`);

    if (!before) {
      continue;
    }

    const pair: [number, number] = [mean(before.allowed), mean(now.allowed)];

    if (inCharge(before) === inCharge(now)) {
      stayed.push(pair);
    } else {
      changed.push(pair);
    }
  }
}

console.log("how well points allowed repeats, by whether he stayed\n");
console.log(
  `  the same coach      ${correlation(stayed).toFixed(3).padStart(7)}` +
  `   (${stayed.length} teams)`,
);
console.log(
  `  a new one           ${correlation(changed).toFixed(3).padStart(7)}` +
  `   (${changed.length} teams)`,
);
console.log(
  `  everybody           ` +
  `${correlation([...stayed, ...changed]).toFixed(3).padStart(7)}`,
);

// what his old side gave up against what his new one does, over every
// move in eleven seasons
const moved: [number, number][] = [];

for (let season = 2016; season <= 2025; season++) {
  for (const [key, now] of years) {
    const [when, team] = key.split("|");

    if (Number(when) !== season) {
      continue;
    }

    const before = years.get(`${season - 1}|${team}`);
    const boss = inCharge(now);

    if (!before || inCharge(before) === boss) {
      continue;
    }

    for (const [older, its] of years) {
      const [then, elsewhere] = older.split("|");

      if (Number(then) === season - 1 && elsewhere !== team &&
        inCharge(its) === boss) {
        moved.push([mean(its.allowed), mean(now.allowed)]);
      }
    }
  }
}

console.log(
  `\n  what he brings from his last side  ` +
  `${correlation(moved).toFixed(3).padStart(7)}   (${moved.length} moves)`,
);
