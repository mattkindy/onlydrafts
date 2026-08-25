/**
 * A defence taken apart the way a player was, and asked by position.
 *
 * Splitting a receiver's yards into how far the ball flew and how far
 * he ran afterwards roughly doubled how much of him lasts. This asks
 * whether the same is true on the other side: does what a defence gives
 * up at each of those, against each position, last better than the
 * points it gives up.
 *
 * Every play counts here rather than every outcome, so a defence has
 * six hundred throws behind its numbers instead of seventeen games.
 *
 * Run: npx tsx scripts/defenceMechanicsEval.ts
 */

import { parseCsv } from "../src/data/csv.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SEASONS = [2021, 2022, 2023, 2024, 2025];
const AGAINST = ["RB", "WR", "TE"];

const positions = new Map<string, string>();

for (const season of SEASONS) {
  for (const s of await loadPlayerStats(season)) {
    positions.set(s.playerId, s.position);
  }
}

const rows = parseCsv(await readFile(
  join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8"));

interface Play {
  season: number;
  defence: string;
  position: string;
  pass: boolean;
  caught: boolean;
  airYards: number | null;
  yards: number;
}

const plays: Play[] = [];

for (const r of rows) {
  const season = Number(r["season"]);
  const who = r["player"] ?? "";

  if (!SEASONS.includes(season) || !who) {
    continue;
  }

  const air = r["airYards"];
  const pass = r["playType"] === "pass";

  plays.push({
    season,
    defence: r["defense"] ?? "",
    position: positions.get(who) ?? "",
    pass,
    caught: r["caught"] === "1",
    airYards: air === "" || air === undefined ? null : Number(air),
    yards: Number(r["yards"]) || 0,
  });
}

interface Way {
  name: string;
  /** the pile it is measured over, and what to add up across it */
  wants: (p: Play) => boolean;
  top: (p: Play) => number;
  bottom: (p: Play) => number;
}

const PASSING: Way[] = [
  { name: "yards a target", wants: (p) => p.pass, top: (p) => p.yards, bottom: () => 1 },
  {
    name: "  depth conceded", wants: (p) => p.pass && p.airYards !== null,
    top: (p) => p.airYards!, bottom: () => 1,
  },
  {
    name: "  after the catch", wants: (p) => p.pass && p.caught && p.airYards !== null,
    top: (p) => p.yards - p.airYards!, bottom: () => 1,
  },
  { name: "  caught on them", wants: (p) => p.pass, top: (p) => (p.caught ? 1 : 0), bottom: () => 1 },
];

const RUNNING: Way[] = [
  { name: "yards a carry", wants: (p) => !p.pass, top: (p) => p.yards, bottom: () => 1 },
];

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

/** a defence needs this many of a thing before its rate means anything */
const ENOUGH = 60;

function carriedBy(way: Way, position: string): { slope: number; n: number; per: number } {
  const bySeason = new Map<number, Map<string, { top: number; n: number }>>();

  for (const p of plays) {
    if (p.position !== position || !way.wants(p)) {
      continue;
    }

    const table = bySeason.get(p.season) ?? new Map();
    const so = table.get(p.defence) ?? { top: 0, n: 0 };
    so.top += way.top(p);
    so.n += way.bottom(p);
    table.set(p.defence, so);
    bySeason.set(p.season, table);
  }

  const rate = new Map<number, Map<string, number>>();
  let seen = 0;
  let cells = 0;

  for (const [season, table] of bySeason) {
    const per = new Map<string, number>();

    for (const [team, a] of table) {
      if (a.n >= ENOUGH) {
        per.set(team, a.top / a.n);
        seen += a.n;
        cells++;
      }
    }

    const mean = [...per.values()].reduce((s, v) => s + v, 0) / Math.max(1, per.size);
    rate.set(season, new Map([...per].map(([t, v]) => [t, mean !== 0 ? v / mean - 1 : 0])));
  }

  const pairs: [number, number][] = [];

  for (let i = 1; i < SEASONS.length; i++) {
    const before = rate.get(SEASONS[i - 1]!);
    const after = rate.get(SEASONS[i]!);

    if (!before || !after) {
      continue;
    }

    for (const [team, was] of before) {
      const now = after.get(team);

      if (now !== undefined) {
        pairs.push([was, now]);
      }
    }
  }

  return { ...slope(pairs), per: cells > 0 ? seen / cells : 0 };
}

console.log("How much of a defence is still there next season, by what it");
console.log("gives up and to whom. A receiver keeps 0.878 of his own depth.\n");
console.log("                            vs RB           vs WR           vs TE");

for (const way of [...PASSING, ...RUNNING]) {
  const cells = AGAINST.map((position) => {
    const its = carriedBy(way, position);

    return Number.isNaN(its.slope)
      ? `too few (${its.n})`.padEnd(14)
      : `${its.slope.toFixed(3)} (${Math.round(its.per)}/yr)`.padEnd(14);
  });

  console.log(`  ${way.name.padEnd(24)} ${cells.join("  ")}`);
}
