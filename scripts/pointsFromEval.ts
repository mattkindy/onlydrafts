/**
 * What decides a week of fantasy scoring, and how much of it is knowable?
 *
 * A better yard a carry ought to mean a better week, and it does not,
 * which only makes sense if a week is mostly decided by something else.
 * So this takes a week apart into the yards, the catches and the scores,
 * says how much of the spread between men each one is worth, and then
 * splits each man's weeks in two to say how much of it is his rather
 * than the luck of that Sunday.
 *
 * Run: npx tsx scripts/pointsFromEval.ts [seasons, comma separated]
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { spearman } from "../src/backtest/metrics.js";

const SEASONS = (process.argv[2] ?? "2024,2025").split(",").map(Number);
const POSITIONS = ["QB", "RB", "WR", "TE"];
const RULES = presets.ppr;

interface Week {
  id: string;
  position: string;
  points: number;
  parts: Record<string, number>;
}

const weeks: Week[] = [];

for (const season of SEASONS) {
  for (const s of await loadPlayerStats(season)) {
    if (s.week > 18 || !POSITIONS.includes(s.position)) {
      continue;
    }

    const line = s.statLine;
    const tds = (line["rushTd"] ?? 0) + (line["recTd"] ?? 0) +
      (line["passTd"] ?? 0);

    weeks.push({
      id: s.playerId,
      position: s.position,
      points: fantasyPoints(line, RULES),
      parts: {
        // each part at what this league pays for it, so they add up
        // to his week and can be compared with each other
        yards: (line["rushYds"] ?? 0) * (RULES["rushYds"] ?? 0.1) +
          (line["recYds"] ?? 0) * (RULES["recYds"] ?? 0.1) +
          (line["passYds"] ?? 0) * (RULES["passYds"] ?? 0.04),
        catches: (line["receptions"] ?? 0) * RULES.receptions,
        scores: tds * 6,
      },
    });
  }
}

/** the men worth starting, since a bench week is not the question */
const played = new Map<string, { n: number; points: number }>();

for (const w of weeks) {
  const own = played.get(w.id) ?? { n: 0, points: 0 };
  own.n++;
  own.points += w.points;
  played.set(w.id, own);
}

const worthIt = new Set(
  [...played.entries()]
    .filter(([, own]) => own.n >= 8 && own.points / own.n >= 10)
    .map(([id]) => id),
);

const spread = (of: number[]) => {
  const mid = of.reduce((a, b) => a + b, 0) / Math.max(1, of.length);

  return Math.sqrt(
    of.reduce((sum, v) => sum + (v - mid) ** 2, 0) / Math.max(1, of.length),
  );
};

console.log(
  `over ${SEASONS.join(" and ")}, men averaging ten a week or more, ` +
  `a week at a time:`,
);

for (const where of [null, ...POSITIONS]) {
  const mine = weeks.filter((w) => worthIt.has(w.id) &&
    (where === null || w.position === where));

  if (mine.length < 100) {
    continue;
  }

  const points = mine.map((w) => w.points);
  const all = spread(points);
  const said: string[] = [];

  for (const part of ["yards", "catches", "scores"]) {
    const its = mine.map((w) => w.parts[part] ?? 0);
    said.push(
      `${part} ${(spread(its) / Math.max(0.01, all)).toFixed(2)} wide, ` +
      `orders the week ${spearman(its, points).toFixed(2)}`,
    );
  }

  console.log(`  ${(where ?? "everyone").padEnd(9)}${String(mine.length).padStart(5)} weeks`);
  console.log(`    ${said.join("\n    ")}`);
}

/**
 * And how much of each part is the man rather than the Sunday. His
 * weeks are split in two and the halves asked whether they agree, so
 * a part nobody could have called reads near nothing here however
 * much of a week it decides.
 */
console.log(`\nhow much of each part is him, over men with 8 weeks or more:`);

for (const part of ["yards", "catches", "scores", "points"]) {
  const halves = new Map<string, { odd: number[]; even: number[] }>();

  for (const w of weeks) {
    if (!worthIt.has(w.id)) {
      continue;
    }

    const own = halves.get(w.id) ?? { odd: [], even: [] };
    const value = part === "points" ? w.points : w.parts[part] ?? 0;
    (own.odd.length <= own.even.length ? own.odd : own.even).push(value);
    halves.set(w.id, own);
  }

  const mid = (of: number[]) =>
    of.reduce((a, b) => a + b, 0) / Math.max(1, of.length);
  const its = [...halves.values()].filter((h) => h.odd.length >= 3 &&
    h.even.length >= 3);

  console.log(
    `  ${part.padEnd(8)}${String(its.length).padStart(4)} men  ` +
    `his two halves agree ${spearman(
      its.map((h) => mid(h.odd)), its.map((h) => mid(h.even)),
    ).toFixed(3)}`,
  );
}

/**
 * And whether scoring is a thing about a man that lasts, which is what
 * says whether the walk could carry it as an attribute the way it
 * already carries how far he is thrown. A touch is a carry or a target,
 * so this is how often the work he gets turns into six points.
 */
const perTouch = new Map<number, Map<string, { touches: number; scores: number }>>();

for (const season of [2021, 2022, 2023, 2024, 2025]) {
  const its = new Map<string, { touches: number; scores: number }>();

  for (const s of await loadPlayerStats(season).catch(() => [])) {
    if (s.week > 18 || !["RB", "WR", "TE"].includes(s.position)) {
      continue;
    }

    const own = its.get(s.playerId) ?? { touches: 0, scores: 0 };
    own.touches += (s.carries ?? 0) + (s.targets ?? 0);
    own.scores += (s.statLine["rushTd"] ?? 0) + (s.statLine["recTd"] ?? 0);
    its.set(s.playerId, own);
  }

  perTouch.set(season, its);
}

console.log("\nscoring a touch, one season against the next, 80 touches in both:");

for (const season of [2022, 2023, 2024]) {
  const before = perTouch.get(season)!;
  const after = perTouch.get(season + 1)!;
  const men = [...before.keys()].filter((id) =>
    before.get(id)!.touches >= 80 && (after.get(id)?.touches ?? 0) >= 80);

  if (men.length < 20) {
    continue;
  }

  const rate = (of: Map<string, { touches: number; scores: number }>, id: string) =>
    of.get(id)!.scores / of.get(id)!.touches;
  console.log(
    `  ${season} to ${season + 1}  ${String(men.length).padStart(4)} men  ` +
    `agrees ${spearman(
      men.map((id) => rate(before, id)), men.map((id) => rate(after, id)),
    ).toFixed(3)}`,
  );
}

/**
 * Whether the goal line work is a role that lasts, which is the thing
 * that would be worth modelling if it does. Scoring a touch barely
 * lasts, so the six points are in getting the ball there rather than
 * in what a man does when he has it.
 */
const nearGoal = new Map<number, Map<string, number>>();
const sideNear = new Map<number, Map<string, number>>();

for (const r of parseCsv(await readFile(
  join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
))) {
  const season = Number(r["season"]);
  const yardline = Number(r["yardline"]);

  if (!r["player"] || !["run", "pass"].includes(r["playType"] ?? "") ||
      !Number.isFinite(yardline) || yardline > 10) {
    continue;
  }

  const its = nearGoal.get(season) ?? new Map<string, number>();
  its.set(r["player"], (its.get(r["player"]) ?? 0) + 1);
  nearGoal.set(season, its);
  const side = sideNear.get(season) ?? new Map<string, number>();
  side.set(r["offense"]!, (side.get(r["offense"]!) ?? 0) + 1);
  sideNear.set(season, side);
}

console.log("\nthe work inside the ten, one season against the next:");

for (const season of [2022, 2023, 2024]) {
  const before = nearGoal.get(season);
  const after = nearGoal.get(season + 1);

  if (!before || !after) {
    continue;
  }

  const men = [...before.keys()].filter((id) =>
    before.get(id)! >= 8 && (after.get(id) ?? 0) >= 1);

  if (men.length < 20) {
    continue;
  }

  console.log(
    `  ${season} to ${season + 1}  ${String(men.length).padStart(4)} men  ` +
    `how many he gets agrees ${spearman(
      men.map((id) => before.get(id)!), men.map((id) => after.get(id) ?? 0),
    ).toFixed(3)}`,
  );
}
