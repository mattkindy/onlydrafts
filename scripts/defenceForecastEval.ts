/**
 * Whether a defence can be forecast better than by repeating last year.
 *
 * The board projects a defence by dividing its last box score by
 * seventeen, which carries a fumble recovery forward at full strength.
 * So this measures each part on its own, then tries a few forecasts
 * against what the defences actually did.
 *
 * Everything a forecast uses is knowable in August: the season before,
 * and who the schedule says they play.
 *
 * Run: npx tsx scripts/defenceForecastEval.ts
 */

import { readFileSync } from "node:fs";

import { parseCsv } from "../src/data/csv.js";

const SEASONS = [2021, 2022, 2023, 2024, 2025];

const DEF_PAYS: Record<string, number> = {
  sack: 1, int: 2, fum_rec: 2, def_td: 6, safe: 2, blk_kick: 2,
};

const PARTS = ["sack", "int", "fum_rec", "def_td", "safe", "blk_kick"];

const bracketPay = (points: number) =>
  points < 1 ? 10 : points <= 6 ? 7 : points <= 13 ? 4 : points <= 20 ? 1
    : points <= 27 ? 0 : points <= 34 ? -1 : -4;

const num = (row: Record<string, string>, key: string) =>
  Number(row[key] ?? 0) || 0;

const games = parseCsv(readFileSync("data/raw/games.csv", "utf8"));

/** what each side gave up and what it scored, week by week */
const gaveUp = new Map<string, number[]>();
const put = new Map<string, number[]>();
const played = new Map<string, string[]>();

for (const g of games) {
  if (!g["home_score"] || Number(g["week"]) > 18) {
    continue;
  }

  const home = num(g, "home_score");
  const away = num(g, "away_score");
  const at = (team: string) => `${g["season"]}|${team}`;

  const add = (map: Map<string, number[]>, key: string, n: number) =>
    map.set(key, [...(map.get(key) ?? []), n]);

  add(gaveUp, at(g["home_team"]!), away);
  add(gaveUp, at(g["away_team"]!), home);
  add(put, at(g["home_team"]!), home);
  add(put, at(g["away_team"]!), away);
  played.set(at(g["home_team"]!),
    [...(played.get(at(g["home_team"]!)) ?? []), g["away_team"]!]);
  played.set(at(g["away_team"]!),
    [...(played.get(at(g["away_team"]!)) ?? []), g["home_team"]!]);
}

const mean = (its: number[]) =>
  its.length ? its.reduce((s, n) => s + n, 0) / its.length : 0;

/** each team's counting parts a game, and what its defence scored */
interface Year {
  parts: Record<string, number>;
  allowed: number;
  ppg: number;
}

const years = new Map<string, Year>();

for (const season of SEASONS) {
  const rows = parseCsv(
    readFileSync(`data/raw/stats_player_week_${season}.csv`, "utf8"),
  );
  const tally = new Map<string, Record<string, number>>();

  for (const row of rows) {
    const week = Number(row["week"]);

    if (!week || week > 18) {
      continue;
    }

    const team = row["team"] ?? "";
    const its = tally.get(team) ?? {};

    its["sack"] = (its["sack"] ?? 0) + num(row, "def_sacks");
    its["int"] = (its["int"] ?? 0) + num(row, "def_interceptions");
    its["fum_rec"] = (its["fum_rec"] ?? 0) + num(row, "def_fumbles");
    its["def_td"] = (its["def_td"] ?? 0) + num(row, "def_tds");
    its["safe"] = (its["safe"] ?? 0) + num(row, "def_safeties");
    its["blk_kick"] = (its["blk_kick"] ?? 0) +
      num(row, "def_punt_blocks") + num(row, "def_fg_blocks") +
      num(row, "def_pat_blocks");
    tally.set(team, its);
  }

  for (const [team, its] of tally) {
    const conceded = gaveUp.get(`${season}|${team}`) ?? [];

    if (!conceded.length) {
      continue;
    }

    const perGame = Object.fromEntries(
      PARTS.map((part) => [part, (its[part] ?? 0) / conceded.length]),
    );
    const scored = mean(conceded.map(bracketPay)) +
      PARTS.reduce((sum, part) => sum + perGame[part]! * DEF_PAYS[part]!, 0);

    years.set(`${season}|${team}`, {
      parts: perGame,
      allowed: mean(conceded),
      ppg: scored,
    });
  }
}

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

const pairsOf = (of: (year: Year, key: string) => number) => {
  const out: [number, number][] = [];

  for (const season of SEASONS.slice(1)) {
    for (const [key, now] of years) {
      const [was, team] = key.split("|");

      if (Number(was) !== season) {
        continue;
      }

      const before = years.get(`${season - 1}|${team}`);

      if (!before) {
        continue;
      }

      out.push([of(before, `${season - 1}|${team}`), now.ppg]);
    }
  }

  return out;
};

console.log("how much of each part carries to next season\n");

for (const part of [...PARTS, "allowed"]) {
  const pairs: [number, number][] = [];

  for (const season of SEASONS.slice(1)) {
    for (const [key, now] of years) {
      const [was, team] = key.split("|");

      if (Number(was) !== season) {
        continue;
      }

      const before = years.get(`${season - 1}|${team}`);

      if (before) {
        pairs.push([
          part === "allowed" ? before.allowed : before.parts[part]!,
          part === "allowed" ? now.allowed : now.parts[part]!,
        ]);
      }
    }
  }

  console.log(
    `  ${part.padEnd(10)} ${correlation(pairs).toFixed(3).padStart(7)}` +
    `   (${pairs.length} pairs)`,
  );
}

/** who they play next season, priced by what those sides scored last */
const scheduleStrength = (key: string) => {
  const [season, team] = key.split("|");
  const next = Number(season) + 1;
  const opponents = played.get(`${next}|${team}`) ?? [];
  const its = opponents
    .map((other) => put.get(`${Number(season)}|${other}`))
    .filter((weeks): weeks is number[] => Boolean(weeks))
    .map(mean);

  return its.length ? mean(its) : 22;
};

console.log("\nforecasting next season's defence points a game\n");

const tried: [string, (year: Year, key: string) => number][] = [
  ["repeat last year, what we do", (y) => y.ppg],
  ["points allowed alone", (y) => -y.allowed],
  ["sacks alone", (y) => y.parts["sack"]!],
  [
    "each part shrunk by what it measured",
    (y) =>
      y.parts["sack"]! * 0.160 * DEF_PAYS["sack"]! +
      y.parts["int"]! * 0.083 * DEF_PAYS["int"]! +
      y.parts["fum_rec"]! * 0.195 * DEF_PAYS["fum_rec"]! -
      y.allowed * 0.259,
  ],
  [
    "the same, with the dead parts dropped",
    (y) =>
      y.parts["sack"]! * 0.160 * DEF_PAYS["sack"]! - y.allowed * 0.259,
  ],
  ["who they play next year", (_, key) => -scheduleStrength(key)],
  [
    "points allowed and the schedule",
    (y, key) => -y.allowed * 0.259 - scheduleStrength(key) * 0.1,
  ],
];

for (const [label, of] of tried) {
  const pairs = pairsOf(of);

  console.log(
    `  ${label.padEnd(38)} ${correlation(pairs).toFixed(3).padStart(7)}` +
    `   (${pairs.length} pairs)`,
  );
}
