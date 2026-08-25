/**
 * Does a scheme carry the numbers, or does the club?
 *
 * How deep a defence lets backs be thrown to keeps 0.569 of itself,
 * which looks like a scheme standing still rather than a quality. If
 * that is right it should fall away when the staff changes.
 *
 * The defensive coordinators only go back one season, so a head coach
 * standing or going is the proxy: a new one nearly always brings his
 * own defence. Offensive coordinators we do have.
 *
 * Run: npx tsx scripts/schemeCarryEval.ts
 */

import { parseCsv } from "../src/data/csv.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SEASONS = [2021, 2022, 2023, 2024, 2025];

const coaches = parseCsv(await readFile(
  join(import.meta.dirname, "..", "data", "curated", "coaches.csv"), "utf8"));

const staff = new Map<string, string>();

for (const r of coaches) {
  staff.set(`${r["role"]}|${r["season"]}|${r["team"]}`, r["name"] ?? "");
}

const stayed = (role: string, team: string, season: number): boolean | null => {
  const was = staff.get(`${role}|${season - 1}|${team}`);
  const now = staff.get(`${role}|${season}|${team}`);

  return was && now ? was === now : null;
};

function slope(pairs: [number, number][]): { slope: number; n: number } {
  const count = pairs.length;

  if (count < 25) {
    return { slope: NaN, n: count };
  }

  const mx = pairs.reduce((s, [x]) => s + x, 0) / count;
  const my = pairs.reduce((s, [, y]) => s + y, 0) / count;
  let top = 0;
  let bottom = 0;

  for (const [x, y] of pairs) {
    top += (x - mx) * (y - my);
    bottom += (x - mx) ** 2;
  }

  return { slope: bottom > 0 ? top / bottom : 0, n: count };
}

const say = (its: { slope: number; n: number }) =>
  Number.isNaN(its.slope)
    ? `too few (${its.n})`.padEnd(16)
    : `${its.slope.toFixed(3)} (${its.n})`.padEnd(16);

// ---- the defence, split by whether the head coach stayed ----

const positions = new Map<string, string>();

for (const season of SEASONS) {
  for (const s of await loadPlayerStats(season)) {
    positions.set(s.playerId, s.position);
  }
}

const touches = parseCsv(await readFile(
  join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8"));

/** how deep each defence let each position be thrown to, by season */
const depth = new Map<string, Map<string, { air: number; n: number }>>();

for (const r of touches) {
  const season = Number(r["season"]);
  const air = r["airYards"];

  if (!SEASONS.includes(season) || r["playType"] !== "pass" ||
      air === "" || air === undefined) {
    continue;
  }

  const position = positions.get(r["player"] ?? "") ?? "";

  if (!["RB", "WR", "TE"].includes(position)) {
    continue;
  }

  const key = `${season}|${position}`;
  const table = depth.get(key) ?? new Map();
  const so = table.get(r["defense"] ?? "") ?? { air: 0, n: 0 };
  so.air += Number(air);
  so.n++;
  table.set(r["defense"] ?? "", so);
  depth.set(key, table);
}

console.log("How deep a defence lets a position be thrown to, next season");
console.log("against last, split by whether the head coach stayed.\n");
console.log("                     head coach stayed   head coach went");

for (const position of ["RB", "WR"]) {
  const kept: [number, number][] = [];
  const went: [number, number][] = [];

  for (let i = 1; i < SEASONS.length; i++) {
    const before = depth.get(`${SEASONS[i - 1]}|${position}`);
    const after = depth.get(`${SEASONS[i]}|${position}`);

    if (!before || !after) {
      continue;
    }

    const levelOf = (t: Map<string, { air: number; n: number }>) => {
      const all = [...t.values()].filter((a) => a.n >= 60);

      return all.reduce((s, a) => s + a.air / a.n, 0) / Math.max(1, all.length);
    };
    const wasLevel = levelOf(before);
    const nowLevel = levelOf(after);

    for (const [team, a] of before) {
      const b = after.get(team);

      if (!b || a.n < 60 || b.n < 60) {
        continue;
      }

      const same = stayed("HC", team, SEASONS[i]!);

      if (same === null) {
        continue;
      }

      const pair: [number, number] = [
        a.air / a.n / wasLevel - 1, b.air / b.n / nowLevel - 1,
      ];
      (same ? kept : went).push(pair);
    }
  }

  console.log(`  vs ${position.padEnd(16)} ${say(slope(kept))}  ${say(slope(went))}`);
}

// ---- the offence, split by whether a man kept his club and his coach ----

const rec = parseCsv(await readFile(
  join(import.meta.dirname, "..", "data", "raw", "advstats_rec.csv"), "utf8"));
const bySeason = new Map<number, Map<string, Record<string, string>>>();

for (const r of rec) {
  const season = Number(r["season"]);

  if (!SEASONS.includes(season) || Number(r["tgt"]) < 45) {
    continue;
  }

  const table = bySeason.get(season) ?? new Map();
  table.set(r["pfr_id"] ?? "", r);
  bySeason.set(season, table);
}

const WAYS: [string, (r: Record<string, string>) => number][] = [
  ["how deep he is thrown", (r) => Number(r["adot"])],
  ["after the catch", (r) => Number(r["yac_r"])],
  ["targets a game", (r) => Number(r["tgt"]) / Number(r["g"])],
];

console.log("\nAnd a receiver, split by whether he kept his club and his");
console.log("coordinator, or moved, or had a new one arrive.\n");
console.log("                        same club, same OC   same club, new OC   moved club");

for (const [name, of] of WAYS) {
  const groups: [number, number][][] = [[], [], []];

  for (let i = 1; i < SEASONS.length; i++) {
    const before = bySeason.get(SEASONS[i - 1]!);
    const after = bySeason.get(SEASONS[i]!);

    if (!before || !after) {
      continue;
    }

    const levelOf = (t: Map<string, Record<string, string>>) => {
      const all = [...t.values()].map(of).filter(Number.isFinite);

      return all.reduce((s, v) => s + v, 0) / Math.max(1, all.length);
    };
    const wasLevel = levelOf(before);
    const nowLevel = levelOf(after);

    for (const [who, was] of before) {
      const now = after.get(who);

      if (!now || wasLevel === 0 || nowLevel === 0) {
        continue;
      }

      const a = of(was);
      const b = of(now);

      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        continue;
      }

      const moved = was["tm"] !== now["tm"];
      const sameCoach = stayed("OC", now["tm"] ?? "", SEASONS[i]!);
      const which = moved ? 2 : sameCoach === false ? 1 : sameCoach ? 0 : -1;

      if (which >= 0) {
        groups[which]!.push([a / wasLevel - 1, b / nowLevel - 1]);
      }
    }
  }

  console.log(
    `  ${name.padEnd(22)} ${groups.map((g) => say(slope(g))).join("  ")}`,
  );
}
