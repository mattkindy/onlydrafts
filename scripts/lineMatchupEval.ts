/**
 * Nobody grades these lines for us, but every offence faces seventeen
 * different fronts and every front faces seventeen lines, so the
 * schedule identifies both sides at once. Fit a blocking number for
 * each offence and a rushing number for each defence so that together
 * they explain the pressure in each meeting, then ask whether either
 * one carries over and whether it moves fantasy scoring.
 *
 * Run: npx tsx scripts/lineMatchupEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { loadPlayerStats, loadGames } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { spearman } from "../src/backtest/metrics.js";

interface Meeting {
  season: number; week: number; offense: string; defense: string;
  dropbacks: number; pressures: number;
}

/**
 * Alternating least squares on the bipartite graph of meetings. Each
 * side's number is whatever makes its games add up once the other
 * side's number is taken as read, and repeating that converges.
 */
function fitSides(meetings: Meeting[], rounds = 60) {
  const block = new Map<string, number>();
  const rush = new Map<string, number>();
  const league =
    meetings.reduce((a, m) => a + m.pressures, 0) /
    meetings.reduce((a, m) => a + m.dropbacks, 0);

  for (const m of meetings) {
    block.set(m.offense, 0);
    rush.set(m.defense, 0);
  }

  const solve = (
    target: Map<string, number>,
    other: Map<string, number>,
    keyOf: (m: Meeting) => string,
    otherOf: (m: Meeting) => string,
  ) => {
    const sum = new Map<string, number>();
    const weight = new Map<string, number>();

    for (const m of meetings) {
      const key = keyOf(m);
      const rate = m.pressures / m.dropbacks;
      const residual = rate - league - (other.get(otherOf(m)) ?? 0);
      sum.set(key, (sum.get(key) ?? 0) + residual * m.dropbacks);
      weight.set(key, (weight.get(key) ?? 0) + m.dropbacks);
    }

    for (const [key, total] of sum) {
      // shrink toward zero so a team with few meetings is not overstated
      target.set(key, total / ((weight.get(key) ?? 1) + 120));
    }
  };

  for (let round = 0; round < rounds; round++) {
    solve(block, rush, (m) => m.offense, (m) => m.defense);
    solve(rush, block, (m) => m.defense, (m) => m.offense);
  }

  return { block, rush, league };
}

async function main(): Promise<void> {
  const rows = parseCsv(
    await readFile(join(import.meta.dirname, "..", "data", "curated", "pressureMatchups.csv"), "utf8"),
  );
  const meetings: Meeting[] = rows.map((r) => ({
    season: Number(r["season"]), week: Number(r["week"]),
    offense: r["offense"] ?? "", defense: r["defense"] ?? "",
    dropbacks: Number(r["dropbacks"]), pressures: Number(r["pressures"]),
  }));

  const seasons = [...new Set(meetings.map((m) => m.season))].sort();
  const fits = new Map(
    seasons.map((s) => [s, fitSides(meetings.filter((m) => m.season === s))]),
  );

  console.log("pressure rates, fitted from who played whom\n");
  console.log("season   league   best line   worst line   best front   worst front");

  for (const season of seasons) {
    const { block, rush, league } = fits.get(season)!;
    const blocks = [...block.values()].sort((a, b) => a - b);
    const rushes = [...rush.values()].sort((a, b) => b - a);
    console.log(
      String(season).padEnd(9) + (league * 100).toFixed(1).padStart(6) + "%" +
      ((blocks[0]! + league) * 100).toFixed(1).padStart(12) + "%" +
      ((blocks.at(-1)! + league) * 100).toFixed(1).padStart(12) + "%" +
      ((rushes[0]! + league) * 100).toFixed(1).padStart(13) + "%" +
      ((rushes.at(-1)! + league) * 100).toFixed(1).padStart(13) + "%",
    );
  }

  // does either side carry over? that is what makes it usable in advance
  const pairs = (get: (f: ReturnType<typeof fitSides>) => Map<string, number>) => {
    const a: number[] = [], b: number[] = [];

    for (const season of seasons.slice(1)) {
      const prev = fits.get(season - 1);
      const now = fits.get(season);
      if (!prev || !now) continue;

      for (const [team, value] of get(now)) {
        const before = get(prev).get(team);
        if (before !== undefined) { a.push(before); b.push(value); }
      }
    }

    return spearman(a, b);
  };

  console.log("\nyear over year:");
  console.log("  the offensive line's blocking   " + pairs((f) => f.block).toFixed(3));
  console.log("  the defensive front's rush      " + pairs((f) => f.rush).toFixed(3));

  // and does the matchup move what a quarterback scores?
  const games = await loadGames();
  const cells: { edge: number; points: number; expected: number }[] = [];

  for (const season of seasons) {
    const fit = fits.get(season)!;
    const stats = await loadPlayerStats(season);
    const qbs = new Map<string, { total: number; games: number }>();

    for (const s of stats) {
      if (s.position !== "QB") continue;
      const e = qbs.get(s.playerId) ?? { total: 0, games: 0 };
      e.total += fantasyPoints(s.statLine, presets.standard);
      e.games++;
      qbs.set(s.playerId, e);
    }

    const opponentOf = new Map<string, string>();

    for (const g of games) {
      if (g.season !== season) continue;
      opponentOf.set(`${g.homeTeamId}|${g.week}`, g.awayTeamId);
      opponentOf.set(`${g.awayTeamId}|${g.week}`, g.homeTeamId);
    }

    for (const s of stats) {
      if (s.position !== "QB") continue;
      const own = qbs.get(s.playerId)!;
      if (own.games < 8) continue;
      const defense = opponentOf.get(`${s.teamId}|${s.week}`);
      if (!defense) continue;
      const edge = (fit.rush.get(defense) ?? 0) - (fit.block.get(s.teamId) ?? 0);
      cells.push({
        edge,
        points: fantasyPoints(s.statLine, presets.standard),
        expected: own.total / own.games,
      });
    }
  }

  cells.sort((a, b) => a.edge - b.edge);
  const third = Math.floor(cells.length / 3);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  console.log(`\nquarterback weeks by how the front matched the line (${cells.length} weeks):`);
  console.log("  matchup                  points against his own average");

  for (const [label, group] of [
    ["line wins", cells.slice(0, third)],
    ["even", cells.slice(third, third * 2)],
    ["front wins", cells.slice(third * 2)],
  ] as [string, typeof cells][]) {
    console.log("  " + label.padEnd(22) +
      (mean(group.map((c) => c.points - c.expected)) >= 0 ? "+" : "") +
      mean(group.map((c) => c.points - c.expected)).toFixed(2));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
