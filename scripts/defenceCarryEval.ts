/**
 * How much of a defence is still there next season, and how much of it
 * is still there next week.
 *
 * The season projection pulls last year's opponent factor 88% of the
 * way back toward level, on the grounds that a defence does not keep
 * much of itself and that a hard schedule and an easy one cancel across
 * a season anyway. A single week gets no such cancelling, so the right
 * amount to keep for one week is its own question, and this measures
 * both: the slope from one season to the next, and the slope from the
 * season so far to the week coming up.
 *
 * Run: npx tsx scripts/defenceCarryEval.ts
 */

import { loadGames, loadPlayerStats } from "../src/data/nflverse.js";
import { parseCsv } from "../src/data/csv.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fantasyPoints } from "../src/scoring/fantasyPoints.js";
import { scoring } from "../src/scoring/active.js";

const POSITIONS = ["QB", "RB", "WR", "TE"];
const SEASONS = [2019, 2020, 2021, 2022, 2023, 2024, 2025];

const games = await loadGames();

/** who each side played, by season and week */
const facing = new Map<string, string>();

for (const g of games) {
  facing.set(`${g.season}|${g.homeTeamId}|${g.week}`, g.awayTeamId);
  facing.set(`${g.season}|${g.awayTeamId}|${g.week}`, g.homeTeamId);
}

interface Cell {
  points: number;
  weeks: Set<number>;
}

/** what each defence gave up at each position, week by week */
const gaveUp = new Map<number, Map<string, Cell>>();
const weekly = new Map<number, Map<string, Map<number, number>>>();

for (const season of SEASONS) {
  const rows = await loadPlayerStats(season);
  const bySeason = new Map<string, Cell>();
  const byWeek = new Map<string, Map<number, number>>();

  for (const row of rows) {
    if (!POSITIONS.includes(row.position) || row.week > 18) {
      continue;
    }

    const defence = facing.get(`${season}|${row.teamId}|${row.week}`);

    if (!defence) {
      continue;
    }

    const points = fantasyPoints(row.statLine, scoring());
    const key = `${defence}|${row.position}`;
    const cell = bySeason.get(key) ?? { points: 0, weeks: new Set<number>() };
    cell.points += points;
    cell.weeks.add(row.week);
    bySeason.set(key, cell);

    const weeks = byWeek.get(key) ?? new Map<number, number>();
    weeks.set(row.week, (weeks.get(row.week) ?? 0) + points);
    byWeek.set(key, weeks);
  }

  gaveUp.set(season, bySeason);
  weekly.set(season, byWeek);
}

/** each cell against what everybody gave up that season, so 1 is average */
function indexed(season: number): Map<string, number> {
  const cells = gaveUp.get(season)!;
  const total = new Map<string, { points: number; weeks: number }>();

  for (const [key, cell] of cells) {
    const position = key.split("|")[1]!;
    const so = total.get(position) ?? { points: 0, weeks: 0 };
    total.set(position, {
      points: so.points + cell.points,
      weeks: so.weeks + cell.weeks.size,
    });
  }

  const out = new Map<string, number>();

  for (const [key, cell] of cells) {
    const position = key.split("|")[1]!;
    const all = total.get(position)!;
    const mean = all.points / all.weeks;

    if (mean > 0 && cell.weeks.size > 0) {
      out.set(key, cell.points / cell.weeks.size / mean);
    }
  }

  return out;
}

/** the slope of y on x, which is how much of x to keep */
function slope(pairs: [number, number][]): { slope: number; n: number } {
  const n = pairs.length;
  const mx = pairs.reduce((s, [x]) => s + x, 0) / n;
  const my = pairs.reduce((s, [, y]) => s + y, 0) / n;
  let top = 0;
  let bottom = 0;

  for (const [x, y] of pairs) {
    top += (x - mx) * (y - my);
    bottom += (x - mx) ** 2;
  }

  return { slope: bottom > 0 ? top / bottom : 0, n };
}

console.log("How much of last season's defence is there this season");
console.log("(1 would mean it is the same defence, 0 that last year says nothing)\n");

const acrossSeasons: [number, number][] = [];
const byPosition = new Map<string, [number, number][]>();

for (let i = 1; i < SEASONS.length; i++) {
  const before = indexed(SEASONS[i - 1]!);
  const after = indexed(SEASONS[i]!);

  for (const [key, was] of before) {
    const now = after.get(key);

    if (now !== undefined) {
      acrossSeasons.push([was - 1, now - 1]);
      const position = key.split("|")[1]!;
      byPosition.set(position, [...(byPosition.get(position) ?? []), [was - 1, now - 1]]);
    }
  }
}

const whole = slope(acrossSeasons);
console.log(`  everyone      ${whole.slope.toFixed(3)}   (${whole.n} pairs)`);

for (const position of POSITIONS) {
  const its = slope(byPosition.get(position) ?? []);
  console.log(`  vs ${position.padEnd(11)}${its.slope.toFixed(3)}   (${its.n} pairs)`);
}

console.log("\nAnd within a season: the weeks so far against the week coming up");
console.log("(this is what an in-season model gets, and it is a different number)\n");

const inSeason: [number, number][] = [];

for (const season of SEASONS) {
  const byWeek = weekly.get(season)!;
  const cells = gaveUp.get(season)!;
  const scale = new Map<string, number>();

  for (const [key, cell] of cells) {
    scale.set(key, cell.points / Math.max(1, cell.weeks.size));
  }

  const level = new Map<string, number>();

  for (const position of POSITIONS) {
    const its = [...scale.entries()].filter(([k]) => k.endsWith(`|${position}`));
    level.set(position, its.reduce((s, [, v]) => s + v, 0) / Math.max(1, its.length));
  }

  for (const [key, weeks] of byWeek) {
    const position = key.split("|")[1]!;
    const mean = level.get(position)!;
    const ordered = [...weeks.entries()].sort((a, b) => a[0] - b[0]);

    // from week 6 on, so there is a season so far worth speaking of
    for (let i = 5; i < ordered.length; i++) {
      const sofar = ordered.slice(0, i).reduce((s, [, p]) => s + p, 0) / i;
      const next = ordered[i]![1];
      inSeason.push([sofar / mean - 1, next / mean - 1]);
    }
  }
}

const during = slope(inSeason);
console.log(`  everyone      ${during.slope.toFixed(3)}   (${during.n} pairs)`);


/**
 * The same question again, split by how much of the defence is still
 * there. A team label absorbs everything at once: men leaving, a new
 * coordinator, and noise. If the men are what carries, then a side that
 * kept its defence should carry a great deal more than 0.200.
 */

const snapsFor = new Map<string, Map<string, number>>();

for (const season of SEASONS) {
  const rows = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "raw", `snap_counts_${season}.csv`),
    "utf8",
  ));

  for (const r of rows) {
    const snaps = Number(r["defense_snaps"]);

    if (r["game_type"] !== "REG" || !Number.isFinite(snaps) || snaps <= 0) {
      continue;
    }

    const key = `${season}|${r["team"]}`;
    const own = snapsFor.get(key) ?? new Map<string, number>();
    const who = r["pfr_player_id"] ?? r["player"] ?? "";
    own.set(who, (own.get(who) ?? 0) + snaps);
    snapsFor.set(key, own);
  }
}

/** the share of last season's defensive snaps played by men still here */
function continuity(team: string, season: number): number | null {
  const was = snapsFor.get(`${season - 1}|${team}`);
  const now = snapsFor.get(`${season}|${team}`);

  if (!was || !now || was.size === 0) {
    return null;
  }

  let kept = 0;
  let all = 0;

  for (const [who, snaps] of was) {
    all += snaps;
    if (now.has(who)) {
      kept += snaps;
    }
  }

  return all > 0 ? kept / all : null;
}

const coordinators = parseCsv(await readFile(
  join(import.meta.dirname, "..", "data", "curated", "coordinators.csv"), "utf8"));
const dcOf = new Map<string, string>();

for (const r of coordinators) {
  if (r["role"] === "DC") {
    dcOf.set(`${r["season"]}|${r["team"]}`, r["name"] ?? "");
  }
}

const sameCoach = (team: string, season: number): boolean | null => {
  const was = dcOf.get(`${season - 1}|${team}`);
  const now = dcOf.get(`${season}|${team}`);

  return was && now ? was === now : null;
};

interface Split {
  name: string;
  pairs: [number, number][];
}

const byKept: Split[] = [
  { name: "kept under 55%", pairs: [] },
  { name: "kept 55 to 70%", pairs: [] },
  { name: "kept over 70%", pairs: [] },
];
const byCoach: Split[] = [
  { name: "new coordinator", pairs: [] },
  { name: "same coordinator", pairs: [] },
];
const both: Split[] = [
  { name: "kept over 70% and same coordinator", pairs: [] },
  { name: "kept under 55% or a new one", pairs: [] },
];

for (let i = 1; i < SEASONS.length; i++) {
  const season = SEASONS[i]!;
  const before = indexed(SEASONS[i - 1]!);
  const after = indexed(season);

  for (const [key, was] of before) {
    const now = after.get(key);
    const team = key.split("|")[0]!;
    const kept = continuity(team, season);

    if (now === undefined || kept === null) {
      continue;
    }

    const pair: [number, number] = [was - 1, now - 1];
    byKept[kept < 0.55 ? 0 : kept < 0.7 ? 1 : 2]!.pairs.push(pair);

    const stayed = sameCoach(team, season);

    if (stayed !== null) {
      byCoach[stayed ? 1 : 0]!.pairs.push(pair);

      if (kept >= 0.7 && stayed) {
        both[0]!.pairs.push(pair);
      } else if (kept < 0.55 || !stayed) {
        both[1]!.pairs.push(pair);
      }
    }
  }
}

console.log("\n\nHow much carries, by how much of the defence is still there\n");

for (const group of [byKept, byCoach, both]) {
  for (const split of group) {
    if (split.pairs.length < 30) {
      console.log(`  ${split.name.padEnd(36)} too few (${split.pairs.length})`);
      continue;
    }

    const its = slope(split.pairs);
    console.log(`  ${split.name.padEnd(36)} ${its.slope.toFixed(3)}   (${its.n} pairs)`);
  }

  console.log("");
}
