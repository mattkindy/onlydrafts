/**
 * Whether a defence repeats better when the same men are still playing.
 *
 * The board projects a defence off its own last season and knows
 * nothing about who left. If a side that kept nine tenths of its snaps
 * repeats far better than one that kept half, then personnel is signal
 * we are throwing away, and the position is more predictable than the
 * team level makes it look.
 *
 * Continuity is the share of last season's defensive snaps played by
 * men on this season's roster, which is knowable before a ball is
 * thrown.
 *
 * Run: npx tsx scripts/defenceContinuityEval.ts
 */

import { readFileSync } from "node:fs";

import { parseCsv } from "../src/data/csv.js";

/** what a man did on defence is only counted from 2021 on */
const PAIRS = [
  [2021, 2022], [2022, 2023], [2023, 2024], [2024, 2025],
] as const;

const num = (row: Record<string, string>, key: string) =>
  Number(row[key] ?? 0) || 0;

const normalize = (name: string) =>
  name.toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?$/, "")
    .replace(/[^a-z]/g, "");

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

/** what each side gave up a game, by season */
const allowed = new Map<string, number[]>();

for (const g of games) {
  if (!g["home_score"] || Number(g["week"]) > 18) {
    continue;
  }

  const at = (team: string) => `${g["season"]}|${team}`;
  const add = (key: string, n: number) =>
    allowed.set(key, [...(allowed.get(key) ?? []), n]);

  add(at(g["home_team"]!), num(g, "away_score"));
  add(at(g["away_team"]!), num(g, "home_score"));
}

const gaveUp = (season: number, team: string) => {
  const its = allowed.get(`${season}|${team}`);

  return its?.length ? mean(its) : null;
};

interface Case {
  team: string;
  before: number;
  after: number;
  continuity: number;
  /** the same, weighting a man by what he did rather than by his snaps */
  byWorth: number;
}

const cases: Case[] = [];

for (const [was, now] of PAIRS) {
  const snaps = parseCsv(
    readFileSync(`data/raw/snap_counts_${was}.csv`, "utf8"),
  );
  const roster = parseCsv(
    readFileSync(`data/raw/roster_weekly_${now}.csv`, "utf8"),
  );

  /** every man on a roster this season, whoever he played for before */
  const playingNow = new Map<string, Set<string>>();

  for (const row of roster) {
    const team = row["team"] ?? "";
    const its = playingNow.get(team) ?? new Set<string>();
    its.add(normalize(row["full_name"] ?? ""));
    playingNow.set(team, its);
  }

  /** last season's defensive snaps, by the side he played them for */
  const played = new Map<string, Map<string, number>>();

  for (const row of snaps) {
    const team = row["team"] ?? "";
    const taken = num(row, "defense_snaps");

    if (!taken) {
      continue;
    }

    const its = played.get(team) ?? new Map<string, number>();
    const key = normalize(row["player"] ?? "");
    its.set(key, (its.get(key) ?? 0) + taken);
    played.set(team, its);
  }

  /**
   * What each man did on defence last season, so a side that keeps its
   * pass rusher is told apart from one that keeps its fourth safety.
   * Pressure and coverage lead, since those are the plays a defence
   * makes rather than the ones it happens to be on the field for.
   */
  const worth = new Map<string, number>();

  for (const row of parseCsv(
    readFileSync(`data/raw/stats_player_week_${was}.csv`, "utf8"),
  )) {
    if (Number(row["week"]) > 18) {
      continue;
    }

    const key = normalize(row["player_display_name"] ?? "");
    const did = num(row, "def_sacks") * 3 +
      num(row, "def_qb_hits") + num(row, "def_pass_defended") * 2 +
      num(row, "def_tackles_for_loss") * 1.5 +
      num(row, "def_interceptions") * 3 +
      num(row, "def_fumbles_forced") * 2 +
      num(row, "def_tackles_solo") * 0.2;

    if (did) {
      worth.set(key, (worth.get(key) ?? 0) + did);
    }
  }

  for (const [team, men] of played) {
    const before = gaveUp(was, team);
    const after = gaveUp(now, team);
    const squad = playingNow.get(team);

    if (before === null || after === null || !squad) {
      continue;
    }

    let all = 0;
    let stayed = 0;
    let allWorth = 0;
    let stayedWorth = 0;

    for (const [man, taken] of men) {
      const did = worth.get(man) ?? 0;
      all += taken;
      allWorth += did;

      if (squad.has(man)) {
        stayed += taken;
        stayedWorth += did;
      }
    }

    if (all > 0 && allWorth > 0) {
      cases.push({
        team, before, after,
        continuity: stayed / all,
        byWorth: stayedWorth / allWorth,
      });
    }
  }
}

console.log(`${cases.length} team seasons over ${PAIRS.length} pairs\n`);
console.log(
  `  snaps kept, on average  ${(mean(cases.map((c) => c.continuity)) * 100)
    .toFixed(0)}%\n`,
);

for (const [what, by] of [
  ["snaps", (c: Case) => c.continuity],
  ["what those men did", (c: Case) => c.byWorth],
] as [string, (c: Case) => number][]) {
  const sorted = [...cases].sort((a, b) => by(a) - by(b));
  const third = Math.floor(sorted.length / 3);
  const groups: [string, Case[]][] = [
    ["turned over the most", sorted.slice(0, third)],
    ["the middle", sorted.slice(third, third * 2)],
    ["kept the most", sorted.slice(third * 2)],
  ];

  console.log(`\nhow points allowed repeats, splitting on ${what}\n`);

  for (const [label, its] of groups) {
    const r = correlation(
      its.map((c) => [c.before, c.after] as [number, number]),
    );

    console.log(
      `  ${label.padEnd(22)} ${r.toFixed(3).padStart(7)}` +
      `   (${its.length} teams, ${(mean(its.map(by)) * 100).toFixed(0)}% kept)`,
    );
  }
}

const whole = correlation(
  cases.map((c) => [c.before, c.after] as [number, number]),
);

console.log(`\n  all of them together   ${whole.toFixed(3)}`);

// last season pulled toward the league average by how much of the side
// walked out, to see whether continuity works as a term and not only as
// a way of splitting the teams up
const league = mean(cases.map((c) => c.before));
const shrunk = correlation(cases.map((c) =>
  [league + (c.before - league) * c.continuity, c.after] as [number, number]));

console.log(
  `  last season shrunk toward the league by who left   ${shrunk.toFixed(3)}`,
);
