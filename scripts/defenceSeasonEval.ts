/**
 * How well each reading of a defence predicts what it pays over the rest
 * of the season.
 *
 * At weeks 3, 4, 6, 8 and 10 of every season from 2017 to 2025, each
 * defence with four or more games left is read three ways: last season a
 * game, which is what the board shipped; this season a game so far; and
 * `defenceLevel`, which pulls last season toward the league's average and
 * lets this season take a share that grows with its games. Each is marked
 * by its error and its correlation against what the defence paid a game
 * from the cut on, under the standard ladder.
 *
 * How many games it takes this season to carry half the weight is picked
 * on 2017 to 2021 and marked on 2022 to 2025, so the shipped number is
 * not marked on the seasons it was chosen on.
 *
 * Run: npx tsx scripts/defenceSeasonEval.ts
 */

import { loadGames, loadTeamDefenceWeeks } from "../src/data/nflverse.js";
import {
  bracketOf, payDefence, STANDARD_DEFENCE_PAYS,
} from "../src/features/defenceWeek.js";
import {
  defenceLevel, SEASON_HALF_GAMES, TOWARD_THE_MIDDLE,
} from "../src/features/defenceSeason.js";

const SEASONS = Array.from({ length: 10 }, (_, i) => 2016 + i);
const CUTS = [3, 4, 6, 8, 10];
const PICKED_THROUGH = 2021;
const HALVES = [1, 2, 3, 4, 6, 8, 12, 17, 25, Infinity];
/** games left after the cut before the rest of a season says anything */
const MIN_LEFT = 4;

interface Read {
  season: number;
  cut: number;
  last: number;
  league: number;
  soFar: number;
  games: number;
  rest: number;
}

const mean = (xs: number[]) =>
  xs.reduce((sum, x) => sum + x, 0) / Math.max(1, xs.length);

function correlation(a: number[], b: number[]): number {
  const ma = mean(a);
  const mb = mean(b);
  let together = 0;
  let spreadA = 0;
  let spreadB = 0;

  for (let i = 0; i < a.length; i++) {
    together += (a[i]! - ma) * (b[i]! - mb);
    spreadA += (a[i]! - ma) ** 2;
    spreadB += (b[i]! - mb) ** 2;
  }

  return together / Math.sqrt(spreadA * spreadB);
}

/** what each defence paid in each week of a season, by club then week */
async function paidBy(
  season: number, allowed: Map<string, number>,
): Promise<Map<string, Map<number, number>>> {
  const out = new Map<string, Map<number, number>>();

  for (const w of await loadTeamDefenceWeeks(season)) {
    const gave = allowed.get(`${season}|${w.week}|${w.teamId}`);

    if (gave === undefined) {
      continue;
    }

    const his = out.get(w.teamId) ?? new Map<number, number>();

    his.set(w.week, payDefence(w.parts, STANDARD_DEFENCE_PAYS) +
      (STANDARD_DEFENCE_PAYS[bracketOf(gave)] ?? 0));
    out.set(w.teamId, his);
  }

  return out;
}

/** the paid level `defenceLevel` gives, with this many games to the half */
function levelAt(read: Read, half: number): number {
  if (!Number.isFinite(half)) {
    return defenceLevel(
      { paid: read.last }, { paid: read.league }, {}, 0)["paid"]!;
  }

  // the shipped blend at another half: its weight on this season is
  // games over games plus the half, so the games are scaled to match
  const games = read.games * SEASON_HALF_GAMES / half;

  return defenceLevel(
    { paid: read.last }, { paid: read.league }, { paid: read.soFar }, games,
  )["paid"]!;
}

async function main(): Promise<void> {
  const allowed = new Map<string, number>();

  for (const g of await loadGames()) {
    if (g.homeScore !== undefined && g.awayScore !== undefined) {
      allowed.set(`${g.season}|${g.week}|${g.homeTeamId}`, g.awayScore);
      allowed.set(`${g.season}|${g.week}|${g.awayTeamId}`, g.homeScore);
    }
  }

  const paid = new Map<number, Map<string, Map<number, number>>>();

  for (const season of SEASONS) {
    paid.set(season, await paidBy(season, allowed));
  }

  const reads: Read[] = [];

  for (const season of SEASONS.slice(1)) {
    const lastSeason = new Map([...paid.get(season - 1)!]
      .map(([team, weeks]) => [team, mean([...weeks.values()])]));
    const league = mean([...lastSeason.values()]);

    for (const cut of CUTS) {
      for (const [team, weeks] of paid.get(season)!) {
        const before = [...weeks].filter(([w]) => w <= cut).map(([, p]) => p);
        const after = [...weeks].filter(([w]) => w > cut).map(([, p]) => p);
        const last = lastSeason.get(team);

        if (before.length === 0 || after.length < MIN_LEFT || last === undefined) {
          continue;
        }

        reads.push({
          season, cut, last, league,
          soFar: mean(before), games: before.length, rest: mean(after),
        });
      }
    }
  }

  const picked = reads.filter((r) => r.season <= PICKED_THROUGH);
  const marked = reads.filter((r) => r.season > PICKED_THROUGH);
  const error = (rows: Read[], said: (r: Read) => number) =>
    mean(rows.map((r) => Math.abs(said(r) - r.rest)));
  const best = HALVES.reduce((a, b) =>
    error(picked, (r) => levelAt(r, b)) < error(picked, (r) => levelAt(r, a))
      ? b : a);

  console.log(
    `${reads.length} defence cuts; last season pulled ` +
      `${TOWARD_THE_MIDDLE * 100}% toward the league's average`);
  console.log(
    `games to half weight picked on 2017-${PICKED_THROUGH}: ${best}, ` +
      `shipped ${SEASON_HALF_GAMES}`);
  console.log(`\nrest of the season, MAE then correlation, ` +
    `${PICKED_THROUGH + 1}-2025`);
  console.log("cut   last season    so far         shipped level");

  for (const cut of CUTS) {
    const rows = marked.filter((r) => r.cut === cut);
    const cell = (said: (r: Read) => number) =>
      `${error(rows, said).toFixed(2)} ${correlation(
        rows.map(said), rows.map((r) => r.rest)).toFixed(2)}`.padEnd(15);

    console.log(`${String(cut).padEnd(6)}${cell((r) => r.last)}` +
      `${cell((r) => r.soFar)}${cell((r) => levelAt(r, SEASON_HALF_GAMES))}`);
  }

  console.log("\ngames to half weight, MAE over every marked cut");
  console.log(HALVES.map((half) =>
    `${Number.isFinite(half) ? half : "never"}: ` +
    error(marked, (r) => levelAt(r, half)).toFixed(3)).join("  "));
}

await main();
