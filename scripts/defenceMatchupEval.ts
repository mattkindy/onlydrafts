/**
 * Whether who a defence plays says anything the betting line does not.
 *
 * The line prices points, and a defence is paid mostly for sacks and
 * turnovers. Offences differ in those apart from how much they score: a
 * side with a poor line gives up sacks in games it wins. So this asks
 * whether an opponent's sacks allowed and giveaways predict a defence's
 * week after the line has had its say.
 *
 * Everything about an opponent is counted from the weeks before the one
 * being predicted, so nothing knows its own answer.
 *
 * Run: npx tsx scripts/defenceMatchupEval.ts
 */

import { readFileSync } from "node:fs";

import { parseCsv } from "../src/data/csv.js";

const SEASONS = [2021, 2022, 2023, 2024, 2025];

const DEF_PAYS: Record<string, number> = {
  sack: 1, int: 2, fum_rec: 2, def_td: 6, safe: 2, blk_kick: 2,
};

const bracketPay = (points: number) =>
  points < 1 ? 10 : points <= 6 ? 7 : points <= 13 ? 4 : points <= 20 ? 1
    : points <= 27 ? 0 : points <= 34 ? -1 : -4;

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

/** the part of y the line does not already account for */
function residuals(pairs: [number, number][]): number[] {
  const xs = pairs.map(([x]) => x);
  const ys = pairs.map(([, y]) => y);
  const mx = mean(xs);
  const my = mean(ys);
  const top = pairs.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0);
  const bottom = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  const slope = bottom ? top / bottom : 0;

  return pairs.map(([x, y]) => y - (my + slope * (x - mx)));
}

const games = parseCsv(readFileSync("data/raw/games.csv", "utf8"));
const scored = new Map<string, number>();
const lineAgainst = new Map<string, number>();

for (const g of games) {
  if (Number(g["week"]) > 18) {
    continue;
  }

  const at = (team: string) => `${g["season"]}|${g["week"]}|${team}`;
  const total = num(g, "total_line");
  const spread = num(g, "spread_line");

  if (g["home_score"]) {
    scored.set(at(g["home_team"]!), num(g, "away_score"));
    scored.set(at(g["away_team"]!), num(g, "home_score"));
  }

  if (total) {
    lineAgainst.set(at(g["home_team"]!), total / 2 - spread / 2);
    lineAgainst.set(at(g["away_team"]!), total / 2 + spread / 2);
  }
}

interface Week {
  season: number;
  week: number;
  team: string;
  against: string;
  points: number;
  /** what the other side gave up in sacks and turnovers, before today */
  sacksAllowed: number | null;
  giveaways: number | null;
  line: number | null;
}

const rows: Week[] = [];

for (const season of SEASONS) {
  const weekly = parseCsv(
    readFileSync(`data/raw/stats_player_week_${season}.csv`, "utf8"),
  );
  const byTeamWeek = new Map<string, {
    against: string; parts: Record<string, number>;
  }>();

  for (const row of weekly) {
    const week = Number(row["week"]);

    if (!week || week > 18) {
      continue;
    }

    const at = `${season}|${week}|${row["team"]}`;
    const its = byTeamWeek.get(at) ??
      { against: row["opponent_team"] ?? "", parts: {} };

    its.parts["sack"] = (its.parts["sack"] ?? 0) + num(row, "def_sacks");
    its.parts["int"] = (its.parts["int"] ?? 0) + num(row, "def_interceptions");
    its.parts["fum_rec"] = (its.parts["fum_rec"] ?? 0) + num(row, "def_fumbles");
    its.parts["def_td"] = (its.parts["def_td"] ?? 0) + num(row, "def_tds");
    its.parts["safe"] = (its.parts["safe"] ?? 0) + num(row, "def_safeties");
    its.parts["blk_kick"] = (its.parts["blk_kick"] ?? 0) +
      num(row, "def_punt_blocks") + num(row, "def_fg_blocks") +
      num(row, "def_pat_blocks");
    byTeamWeek.set(at, its);
  }

  /** what each side has given up so far, week by week as it accrues */
  const givenUp = new Map<string, { sacks: number; away: number; games: number }>();

  for (let week = 1; week <= 18; week++) {
    const here = [...byTeamWeek]
      .filter(([at]) => at.startsWith(`${season}|${week}|`));

    for (const [at, its] of here) {
      const team = at.split("|")[2]!;
      const gave = scored.get(at);

      if (gave === undefined || !its.against) {
        continue;
      }

      const so = givenUp.get(its.against);
      const points = bracketPay(gave) +
        Object.entries(DEF_PAYS)
          .reduce((sum, [part, pay]) => sum + (its.parts[part] ?? 0) * pay, 0);

      rows.push({
        season, week, team, against: its.against, points,
        sacksAllowed: so && so.games >= 3 ? so.sacks / so.games : null,
        giveaways: so && so.games >= 3 ? so.away / so.games : null,
        line: lineAgainst.get(at) ?? null,
      });
    }

    // only after the week is scored does it count toward what a side
    // has given up, so nothing is predicted from its own result
    for (const [at, its] of here) {
      const so = givenUp.get(its.against) ?? { sacks: 0, away: 0, games: 0 };
      so.sacks += its.parts["sack"] ?? 0;
      so.away += (its.parts["int"] ?? 0) + (its.parts["fum_rec"] ?? 0);
      so.games++;
      givenUp.set(its.against, so);
    }
  }
}

const usable = rows.filter((r) =>
  r.line !== null && r.sacksAllowed !== null && r.giveaways !== null);

console.log(`${usable.length} defence weeks with a line and an opponent read\n`);

const points = usable.map((r) => r.points);
const line = usable.map((r) => -r.line!);
const sacks = usable.map((r) => r.sacksAllowed!);
const away = usable.map((r) => r.giveaways!);

const pairs = (xs: number[]): [number, number][] =>
  xs.map((x, i) => [x, points[i]!]);

console.log("each on its own, against a defence's week\n");
console.log(`  the betting line              ${correlation(pairs(line)).toFixed(3)}`);
console.log(`  sacks that side gives up      ${correlation(pairs(sacks)).toFixed(3)}`);
console.log(`  turnovers that side gives up  ${correlation(pairs(away)).toFixed(3)}`);

const left = residuals(pairs(line));
const leftPairs = (xs: number[]): [number, number][] =>
  xs.map((x, i) => [x, left[i]!]);

console.log("\nand against what the line leaves behind\n");
console.log(`  sacks that side gives up      ${correlation(leftPairs(sacks)).toFixed(3)}`);
console.log(`  turnovers that side gives up  ${correlation(leftPairs(away)).toFixed(3)}`);

const z = (xs: number[]) => {
  const m = mean(xs);
  const sd = Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));

  return xs.map((x) => (sd ? (x - m) / sd : 0));
};

/**
 * Fitted rather than weighted by hand, so the three get their best
 * shot. Half the weeks fit it and the other half score it, since a fit
 * graded on its own rows always flatters itself.
 */
function fitAndScore(columns: number[][], y: number[]) {
  const n = y.length;
  const half = Math.floor(n / 2);
  const width = columns.length;
  const rows = Array.from({ length: n }, (_, i) => columns.map((c) => c[i]!));
  const left = Array.from({ length: width }, () => new Array(width).fill(0));
  const right = new Array(width).fill(0);

  for (let i = 0; i < half; i++) {
    for (let a = 0; a < width; a++) {
      right[a] += rows[i]![a]! * y[i]!;

      for (let b = 0; b < width; b++) {
        left[a]![b] += rows[i]![a]! * rows[i]![b]!;
      }
    }
  }

  // a nudge down the diagonal, so three columns that move together
  // cannot blow the solve up
  for (let a = 0; a < width; a++) {
    left[a]![a] += 1e-6 * half;
  }

  const weights = solve(left, right);
  const said: [number, number][] = [];

  for (let i = half; i < n; i++) {
    said.push([
      rows[i]!.reduce((sum, x, a) => sum + x * weights[a]!, 0),
      y[i]!,
    ]);
  }

  return correlation(said);
}

function solve(left: number[][], right: number[]): number[] {
  const width = right.length;
  const m = left.map((row, i) => [...row, right[i]!]);

  for (let col = 0; col < width; col++) {
    let best = col;

    for (let r = col + 1; r < width; r++) {
      if (Math.abs(m[r]![col]!) > Math.abs(m[best]![col]!)) {
        best = r;
      }
    }

    [m[col], m[best]] = [m[best]!, m[col]!];

    const lead = m[col]![col]!;

    for (let r = 0; r < width; r++) {
      if (r === col || !lead) {
        continue;
      }

      const factor = m[r]![col]! / lead;

      const row = m[r]!;

      for (let c = col; c <= width; c++) {
        row[c] = row[c]! - factor * m[col]![c]!;
      }
    }
  }

  return m.map((row, i) => {
    const lead = row[i];

    return lead ? row[width]! / lead : 0;
  });
}

const ones = points.map(() => 1);

console.log("\nfitted on half the weeks and scored on the other half\n");
console.log(
  `  the line alone                ` +
  `${fitAndScore([ones, z(line)], points).toFixed(3)}`,
);
console.log(
  `  the line, sacks and turnovers ` +
  `${fitAndScore([ones, z(line), z(sacks), z(away)], points).toFixed(3)}`,
);
