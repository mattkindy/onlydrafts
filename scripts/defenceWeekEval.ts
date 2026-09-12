/**
 * How the board's defence number does against Sleeper's, week by week.
 *
 * The board divides last season's box score by seventeen, so every week
 * gets the same number no matter who the defence plays, while Sleeper
 * projects each week on its own. Which defence to start is a question
 * about the order within a week, so the rank correlation inside a week
 * is the measure that matters, with the error and bias beside it. A
 * rival runs alongside them, from a defence's own recent weeks, the
 * opponent's giveaways and sacks allowed, and the betting line.
 *
 * Run: npx tsx scripts/defenceWeekEval.ts
 */

import { readFileSync, writeFileSync } from "node:fs";

import { parseCsv } from "../src/data/csv.js";
import { loadTeamDefenceWeeks } from "../src/data/nflverse.js";
import {
  defenceProjectionsToCsv,
  joinDefenceProjections,
  loadSleeperDefences,
  SLEEPER_DEFENCE_PATH,
  type SleeperDefence,
  type SleeperProjectionRow,
} from "../src/data/sleeperProjections.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import {
  bracketOf,
  DEFENCE_PARTS,
  payDefence,
  projectDefenceWeek,
  STANDARD_DEFENCE_PAYS,
  TRAILING_WEEKS as TRAILING,
} from "../src/features/defenceWeek.js";

const SEASONS = [2024, 2025];
const CURRENT = 2026;
const LAST_WEEK = 18;
const PAUSE_MS = 300;

const PARTS = DEFENCE_PARTS;

const bracketPay = (points: number) =>
  STANDARD_DEFENCE_PAYS[bracketOf(points)] ?? 0;

const num = (row: Record<string, string>, key: string) =>
  Number(row[key] ?? 0) || 0;

const mean = (its: number[]) =>
  its.length ? its.reduce((s, n) => s + n, 0) / its.length : 0;

const paidParts = (parts: Record<string, number>) =>
  payDefence(
    Object.fromEntries(PARTS.map((part) => [part, parts[part] ?? 0])),
    STANDARD_DEFENCE_PAYS,
  );

// ---------------------------------------------------------------- Sleeper

type SleeperWeek = SleeperDefence;

const sleeperKey = (season: number, week: number, team: string) =>
  `${season}|${week}|${team}`;

function projectionsUrl(season: number, week: number): string {
  return `https://api.sleeper.com/projections/nfl/${season}/${week}` +
    `?season_type=regular&position[]=DEF`;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchSleeperWeek(
  season: number,
  week: number,
): Promise<SleeperWeek[]> {
  const response = await fetch(projectionsUrl(season, week));

  if (!response.ok) {
    throw new Error(`sleeper ${season} week ${week} returned ${response.status}`);
  }

  const raw = (await response.json()) as SleeperProjectionRow[];

  return Array.isArray(raw) ? joinDefenceProjections(season, week, raw) : [];
}

/** whatever the curated file is missing, asked for a week at a time */
async function loadSleeper(seasons: number[]): Promise<Map<string, SleeperWeek>> {
  const kept = new Map(await loadSleeperDefences());
  let fetched = 0;

  for (const season of seasons) {
    for (let week = 1; week <= LAST_WEEK; week++) {
      const already = [...kept.values()]
        .some((r) => r.season === season && r.week === week);

      if (already) {
        continue;
      }

      const rows = await fetchSleeperWeek(season, week);
      await pause(PAUSE_MS);

      if (rows.length === 0) {
        console.log(`sleeper ${season} week ${week}: nothing, stopping`);
        break;
      }

      for (const row of rows) {
        kept.set(sleeperKey(season, week, row.team), row);
      }

      fetched += rows.length;
    }
  }

  if (fetched) {
    writeFileSync(
      SLEEPER_DEFENCE_PATH, defenceProjectionsToCsv([...kept.values()]),
    );
    console.log(`fetched ${fetched} sleeper defence weeks, kept ${kept.size}`);
  } else {
    console.log(`${kept.size} sleeper defence weeks from the curated file`);
  }

  return kept;
}

// ----------------------------------------------------------- what happened

const games = parseCsv(readFileSync("data/raw/games.csv", "utf8"));
const scored = new Map<string, number>();
const lineAgainst = new Map<string, number>();

for (const g of games) {
  if (Number(g["week"]) > LAST_WEEK || g["game_type"] !== "REG") {
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

interface TeamWeek {
  against: string;
  parts: Record<string, number>;
}

async function countSeason(season: number): Promise<Map<string, TeamWeek>> {
  return new Map(
    (await loadTeamDefenceWeeks(season)).map((w) =>
      [`${w.week}|${w.teamId}`, { against: w.opponentId, parts: w.parts }]),
  );
}

const counted = new Map<number, Map<string, TeamWeek>>();

async function countSeasons(): Promise<void> {
  for (const season of [...SEASONS, Math.min(...SEASONS) - 1]) {
    counted.set(season, await countSeason(season));
  }
}

interface BoardYear {
  paid: number;
  parts: Record<string, number>;
  bracket: number;
  allowed: number;
}

/**
 * The board's number for a defence, from last season's parts and
 * brackets over the games it played. Averaging the bracket a season
 * landed in each week is the arithmetic the board does when it spreads
 * a season's bracket hits over seventeen weeks.
 */
function boardYears(season: number): Map<string, BoardYear> {
  const weeks = counted.get(season);
  const out = new Map<string, BoardYear>();

  if (!weeks) {
    return out;
  }

  const tally = new Map<string, { parts: Record<string, number>; gave: number[] }>();

  for (const [at, its] of weeks) {
    const [week, team] = at.split("|") as [string, string];
    const gave = scored.get(`${season}|${week}|${team}`);

    if (gave === undefined) {
      continue;
    }

    const so = tally.get(team) ?? { parts: {}, gave: [] };

    for (const part of PARTS) {
      so.parts[part] = (so.parts[part] ?? 0) + (its.parts[part] ?? 0);
    }

    so.gave.push(gave);
    tally.set(team, so);
  }

  for (const [team, so] of tally) {
    const perGame = Object.fromEntries(
      PARTS.map((part) => [part, (so.parts[part] ?? 0) / so.gave.length]),
    );
    const bracket = mean(so.gave.map(bracketPay));

    out.set(team, {
      paid: bracket + paidParts(perGame),
      parts: perGame,
      bracket,
      allowed: mean(so.gave),
    });
  }

  return out;
}

const boards = new Map<number, Map<string, BoardYear>>();

/** the counted weeks and the board's numbers off them, in that order */
async function readSeasons(): Promise<void> {
  await countSeasons();

  for (const season of [...SEASONS, Math.min(...SEASONS) - 1]) {
    boards.set(season, boardYears(season));
  }
}

// ------------------------------------------------------------- the rows

interface Row {
  season: number;
  week: number;
  team: string;
  against: string;
  actual: number;
  board: number;
  sleeper: number;
  sleeperParts: number;
  /** the defence's own recent paid weeks, last season's average early on */
  trailing: number;
  /** its own paid weeks so far this season, oldest first */
  ownPaid: number[];
  /** its own counting parts a game over the most recent of those weeks */
  ownParts: Record<string, number>;
  ownGames: number;
  oppGiveaways: number;
  oppSacksAllowed: number;
  /** what the line says the other side scores */
  impliedAgainst: number;
  /** what the other side actually scored */
  allowed: number;
  /** its own counting parts that week */
  parts: Record<string, number>;
}

function buildRows(sleeper: Map<string, SleeperWeek>): Row[] {
  const rows: Row[] = [];

  for (const season of SEASONS) {
    const weeks = counted.get(season)!;
    const lastYear = boards.get(season - 1)!;
    const ownPaid = new Map<string, number[]>();
    const ownWeeks = new Map<string, Record<string, number>[]>();
    const gaveUp = new Map<string, { sacks: number; away: number; games: number }>();

    for (let week = 1; week <= LAST_WEEK; week++) {
      const here = [...weeks].filter(([at]) => at.startsWith(`${week}|`));
      const scoredHere: { team: string; against: string; paid: number }[] = [];

      for (const [at, its] of here) {
        const team = at.split("|")[1]!;
        const gave = scored.get(`${season}|${week}|${team}`);

        if (gave === undefined || !its.against) {
          continue;
        }

        const paid = bracketPay(gave) + paidParts(its.parts);
        scoredHere.push({ team, against: its.against, paid });

        const said = sleeper.get(sleeperKey(season, week, team));
        const board = lastYear.get(team);
        const line = lineAgainst.get(`${season}|${week}|${team}`);

        if (!said || !board || line === undefined) {
          continue;
        }

        const own = ownPaid.get(team) ?? [];
        const ownRecent = (ownWeeks.get(team) ?? []).slice(-TRAILING);
        const so = gaveUp.get(its.against);
        const oppYear = lastYear.get(its.against);
        const giveaways = so && so.games >= 2
          ? so.away / so.games
          : (oppYear?.parts["int"] ?? 0) + (oppYear?.parts["fum_rec"] ?? 0);
        const sacksAllowed = so && so.games >= 2
          ? so.sacks / so.games
          : oppYear?.parts["sack"] ?? 2.4;

        rows.push({
          season, week, team, against: its.against,
          actual: paid,
          board: board.paid,
          sleeper: said.points,
          sleeperParts: bracketPay(said.pointsAllowed) + paidParts(said.parts),
          trailing: own.length ? mean(own.slice(-TRAILING)) : board.paid,
          ownPaid: [...own],
          ownGames: ownRecent.length,
          ownParts: ownRecent.length
            ? Object.fromEntries(PARTS.map((part) =>
              [part, mean(ownRecent.map((w) => w[part] ?? 0))]))
            : board.parts,
          oppGiveaways: giveaways,
          oppSacksAllowed: sacksAllowed,
          impliedAgainst: line,
          allowed: gave,
          parts: its.parts,
        });
      }

      // a week counts toward the trailing reads only once it is scored,
      // so nothing is predicted from its own result
      for (const { team, against, paid } of scoredHere) {
        ownPaid.set(team, [...(ownPaid.get(team) ?? []), paid]);

        const its = weeks.get(`${week}|${team}`)!;
        ownWeeks.set(team, [...(ownWeeks.get(team) ?? []), its.parts]);
        const so = gaveUp.get(against) ?? { sacks: 0, away: 0, games: 0 };
        so.sacks += its.parts["sack"] ?? 0;
        so.away += (its.parts["int"] ?? 0) + (its.parts["fum_rec"] ?? 0);
        so.games++;
        gaveUp.set(against, so);
      }
    }
  }

  return rows;
}

// -------------------------------------------------------------- the rival

const rivalFeatures = (r: Row) => [
  1,
  r.trailing,
  r.oppGiveaways,
  r.oppSacksAllowed,
  r.impliedAgainst,
];

/** the same without the opponent's giveaways, whose weight will not settle */
const shorterFeatures = (r: Row) => [
  1,
  r.trailing,
  r.oppSacksAllowed,
  r.impliedAgainst,
];

/**
 * Fitted on one season and scored on the other, both ways round, since
 * a fit graded on its own rows flatters itself.
 */
function fitRival(
  rows: Row[], features: (r: Row) => number[], names: string[],
): Map<Row, number> {
  const said = new Map<Row, number>();

  for (const season of SEASONS) {
    const train = rows.filter((r) => r.season !== season);
    const test = rows.filter((r) => r.season === season);
    const weights = fitRidge(
      train.map(features),
      train.map((r) => r.actual),
      1,
    );
    console.log(
      `  fit without ${season}: ` +
      names.map((name, i) => `${name} ${weights[i]!.toFixed(2)}`).join(", "),
    );

    for (const r of test) {
      said.set(r, predictRidge(weights, features(r)));
    }
  }

  return said;
}

/** the numbers the shipped module uses, fitted on both seasons at once */
function printConstants(rows: Row[]): void {
  const weights = fitRidge(
    rows.map(shorterFeatures), rows.map((r) => r.actual), 1,
  );
  console.log(
    `\nthe shipped fit, on both seasons: base ${weights[0]!.toFixed(4)}, ` +
    `own recent ${weights[1]!.toFixed(4)}, ` +
    `sacks allowed ${weights[2]!.toFixed(4)}, ` +
    `implied against ${weights[3]!.toFixed(4)}`,
  );

  console.log(
    "league mean parts a game  " +
    PARTS.map((p) => `${p} ${mean(rows.map((r) => r.parts[p] ?? 0)).toFixed(4)}`)
      .join(", "),
  );

  const line = fitRidge(
    rows.map((r) => [1, r.impliedAgainst]), rows.map((r) => r.allowed), 1,
  );
  const left = rows.map((r) =>
    r.allowed - (line[0]! + line[1]! * r.impliedAgainst));
  console.log(
    `points allowed against the implied total: ${line[0]!.toFixed(4)} + ` +
    `${line[1]!.toFixed(4)} x implied, spread ` +
    `${Math.sqrt(mean(left.map((n) => n * n))).toFixed(4)}`,
  );
}

// --------------------------------------------------------------- scoring

function ranks(xs: number[]): number[] {
  const order = xs.map((x, i) => [x, i] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(xs.length).fill(0);
  let i = 0;

  while (i < order.length) {
    let j = i;

    while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) {
      j++;
    }

    const tied = (i + j) / 2 + 1;

    for (let k = i; k <= j; k++) {
      out[order[k]![1]!] = tied;
    }

    i = j + 1;
  }

  return out;
}

function spearman(pairs: [number, number][]): number {
  const xs = ranks(pairs.map(([x]) => x));
  const ys = ranks(pairs.map(([, y]) => y));
  const mx = mean(xs);
  const my = mean(ys);
  const top = xs.reduce((s, x, i) => s + (x - mx) * (ys[i]! - my), 0);
  const left = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0));
  const right = Math.sqrt(ys.reduce((s, y) => s + (y - my) ** 2, 0));

  return left && right ? top / (left * right) : 0;
}

function score(rows: Row[], said: (r: Row) => number) {
  const byWeek = new Map<string, Row[]>();

  for (const r of rows) {
    const at = `${r.season}|${r.week}`;
    byWeek.set(at, [...(byWeek.get(at) ?? []), r]);
  }

  const rhos = [...byWeek.values()]
    .filter((week) => week.length >= 8)
    .map((week) => spearman(week.map((r) => [said(r), r.actual])));

  return {
    mae: mean(rows.map((r) => Math.abs(said(r) - r.actual))),
    bias: mean(rows.map((r) => said(r) - r.actual)),
    rho: mean(rhos),
  };
}

function table(
  name: string,
  rows: Row[],
  candidates: [string, (r: Row) => number][],
): void {
  console.log(`\n${name}: ${rows.length} defence weeks`);
  console.log("  candidate           MAE   bias   rank corr");

  for (const [label, said] of candidates) {
    const s = score(rows, said);
    console.log(
      `  ${label.padEnd(18)} ${s.mae.toFixed(2).padStart(5)}  ` +
      `${s.bias.toFixed(2).padStart(5)}   ${s.rho.toFixed(4).padStart(7)}`,
    );
  }
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  await readSeasons();
  const sleeper = await loadSleeper([...SEASONS, CURRENT]);

  for (const season of [...SEASONS, CURRENT]) {
    const weeks = [...new Set(
      [...sleeper.values()].filter((r) => r.season === season).map((r) => r.week),
    )].sort((a, b) => a - b);
    console.log(
      `sleeper ${season}: weeks ${weeks.length ? weeks.join(",") : "none"}`,
    );
  }

  const rows = buildRows(sleeper);
  console.log(
    `\n${rows.length} defence weeks with an actual, a board number and ` +
    `a sleeper number`,
  );

  const apart = rows.filter((r) => Math.abs(r.sleeper - r.sleeperParts) > 0.75);
  console.log(
    `sleeper's pts_std and its parts paid under our ladder are more than ` +
    `three quarters of a point apart on ${apart.length} of ${rows.length} ` +
    `weeks, mean gap ${mean(rows.map((r) => r.sleeper - r.sleeperParts)).toFixed(2)}`,
  );

  printConstants(rows);

  console.log("\nthe rival, fitted on one season and scored on the other");
  const rival = fitRival(rows, rivalFeatures, [
    "base", "own recent", "opp giveaways", "opp sacks allowed",
    "per point the line expects against",
  ]);
  console.log("the same without the opponent's giveaways");
  const shorter = fitRival(rows, shorterFeatures, [
    "base", "own recent", "opp sacks allowed",
    "per point the line expects against",
  ]);

  const floor = new Map(
    SEASONS.map((season) => [
      season,
      mean(rows.filter((r) => r.season !== season).map((r) => r.actual)),
    ]),
  );

  const shipped = (r: Row) => projectDefenceWeek({
    ownPaid: r.ownPaid,
    lastYearPaid: r.board,
    ownParts: r.ownParts,
    ownGames: r.ownGames,
    oppSacksAllowed: r.oppSacksAllowed,
    impliedAgainst: r.impliedAgainst,
  }).paid;
  const rivalSaid = (r: Row) => rival.get(r) ?? 0;
  const bothSaid = (r: Row) => (rivalSaid(r) + r.sleeperParts) / 2;

  const candidates: [string, (r: Row) => number][] = [
    ["ours (the board)", (r) => r.board],
    ["sleeper", (r) => r.sleeper],
    ["sleeper's parts", (r) => r.sleeperParts],
    ["rival", rivalSaid],
    ["rival, no giveaways", (r) => shorter.get(r) ?? 0],
    ["rival + sleeper", bothSaid],
    ["sleeper then rival", (r) => (r.week <= 4 ? r.sleeperParts : rivalSaid(r))],
    ["shipped parts", shipped],
    ["what ships", (r) => (r.week <= 4 ? r.sleeperParts : shipped(r))],
    ["ours + sleeper", (r) => (r.board + r.sleeper) / 2],
    ["perfect", (r) => r.actual],
    ["constant", (r) => floor.get(r.season) ?? 0],
  ];

  table("every week", rows, candidates);
  table("weeks 1 to 4", rows.filter((r) => r.week <= 4), candidates);
  table("weeks 5 on", rows.filter((r) => r.week >= 5), candidates);

  for (const season of SEASONS) {
    table(`${season}`, rows.filter((r) => r.season === season), candidates);
  }

  console.log(`\n${CURRENT} week 1, side by side`);
  const lastYear = boards.get(Math.max(...SEASONS))!;

  for (const team of ["BUF", "LAC"]) {
    const said = sleeper.get(sleeperKey(CURRENT, 1, team));
    const board = lastYear.get(team);

    if (!said || !board) {
      console.log(`  ${team}: missing a number`);
      continue;
    }

    const asOurs = bracketPay(said.pointsAllowed) + paidParts(said.parts);
    console.log(
      `\n  ${team}  sleeper ${said.points.toFixed(2)} ` +
      `(its parts under our ladder ${asOurs.toFixed(2)}), ` +
      `board ${board.paid.toFixed(2)}`,
    );
    console.log(
      `    sleeper parts   ` +
      PARTS.map((p) => `${p} ${(said.parts[p] ?? 0).toFixed(2)}`).join(", ") +
      `, points allowed ${said.pointsAllowed.toFixed(1)}`,
    );
    console.log(
      `    board per game  ` +
      PARTS.map((p) => `${p} ${(board.parts[p] ?? 0).toFixed(2)}`).join(", ") +
      `, points allowed ${board.allowed.toFixed(1)} ` +
      `(bracket pay ${board.bracket.toFixed(2)})`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
