/**
 * A game is one event, not eleven. Everyone on an offence shares the
 * same afternoon, so a week's error splits in two: how much the whole
 * offence produced, and how it was divided.
 *
 * Worth separating because Vegas is good at the first and nobody has
 * shown they are good at the second.
 *
 * Run: npx tsx scripts/perGameEval.ts
 */

import { loadGames, loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { spearman } from "../src/backtest/metrics.js";
import { seededRng } from "../src/sim/rng.js";
import { normalDraw } from "../src/sim/normal.js";
import { fitRoles } from "../src/features/fitRoles.js";
import {
  forGame, simulateSituationalWeek,
} from "../src/model/situationalWeek.js";
import type { Draws } from "../src/model/playerWeek.js";

const RULES = presets.standard;
const SCORE_ON = 2025;
const RUNS = 150;

async function main(): Promise<void> {
  const positions = new Map<string, string>();
  const games = new Map<string, number>();

  for (const s of await loadPlayerStats(SCORE_ON - 1)) {
    positions.set(s.playerId, s.position);
    games.set(s.playerId, (games.get(s.playerId) ?? 0) + 1);
  }

  const { byTeam, playsByTeam } = await fitRoles(SCORE_ON - 1, positions, games);
  const lineOf = new Map<string, { favouredBy: number; total: number; wind: number }>();

  for (const game of await loadGames()) {
    if (game.week > 18 || game.season !== SCORE_ON) continue;
    for (const [team, sign] of [
      [game.homeTeamId, 1], [game.awayTeamId, -1],
    ] as [string, number][]) {
      lineOf.set(`${game.week}|${team}`, {
        favouredBy: (game.spreadLine ?? 0) * sign,
        total: game.totalLine ?? 45,
        wind: game.indoors ? 0 : (game.wind ?? 0),
      });
    }
  }

  // what each offence's skill players actually did each week
  const actualTeamWeek = new Map<string, number>();
  const actualPlayerWeek = new Map<string, number>();

  for (const row of await loadPlayerStats(SCORE_ON)) {
    if (row.week > 18 || !["RB", "WR", "TE"].includes(row.position)) continue;
    const points = fantasyPoints(row.statLine, RULES);
    const key = `${row.week}|${row.teamId}`;
    actualTeamWeek.set(key, (actualTeamWeek.get(key) ?? 0) + points);
    actualPlayerWeek.set(`${row.playerId}|${row.week}`, points);
  }

  const rng = seededRng(17);
  const draws: Draws = { uniform: rng, normal: () => normalDraw(rng) };

  const teamRows: { predicted: number; actual: number; total: number }[] = [];
  const shareRows: { predicted: number; actual: number }[] = [];

  for (const [team, roster] of byTeam) {
    const base = { plays: playsByTeam.get(team)! };

    for (let week = 1; week <= 18; week++) {
      const line = lineOf.get(`${week}|${team}`);
      const actualTeam = actualTeamWeek.get(`${week}|${team}`);
      if (!line || actualTeam === undefined) continue;

      const world = forGame(base, { ...line, opponent: 1 });
      const perPlayer = roster.map(() => 0);
      let teamTotal = 0;

      for (let run = 0; run < RUNS; run++) {
        simulateSituationalWeek(world, roster, draws).forEach((one, i) => {
          if (!one.played) return;
          const points = fantasyPoints(one, RULES);
          perPlayer[i] = perPlayer[i]! + points;
          teamTotal += points;
        });
      }

      teamRows.push({
        predicted: teamTotal / RUNS, actual: actualTeam, total: line.total,
      });

      // and how the afternoon was divided, given what it added up to
      const predictedTeam = teamTotal / RUNS;

      roster.forEach((role, i) => {
        const actual = actualPlayerWeek.get(`${role.playerId}|${week}`);
        if (actual === undefined || predictedTeam <= 0 || actualTeam <= 0) return;
        shareRows.push({
          predicted: perPlayer[i]! / RUNS / predictedTeam,
          actual: actual / actualTeam,
        });
      });
    }
  }

  const teamActual = teamRows.map((r) => r.actual);
  const mean = teamActual.reduce((a, b) => a + b, 0) / teamActual.length;

  console.log(`${teamRows.length} team-weeks, ${shareRows.length} player-weeks in ${SCORE_ON}\n`);
  console.log("what a whole offence produced that week");
  console.log("  the average offence made " + mean.toFixed(1) + " points\n");
  console.log("  predictor                 spearman   average miss   as a share");

  for (const [label, get] of [
    ["the simulation", (r: (typeof teamRows)[number]) => r.predicted],
    ["the game total alone", (r: (typeof teamRows)[number]) => r.total],
    ["the league average", () => mean],
  ] as [string, (r: (typeof teamRows)[number]) => number][]) {
    const guess = teamRows.map(get);
    const miss = guess.map((g, i) => Math.abs(g - teamActual[i]!));
    const average = miss.reduce((a, b) => a + b, 0) / miss.length;
    console.log(
      "  " + label.padEnd(26) + spearman(guess, teamActual).toFixed(4).padStart(9) +
      average.toFixed(1).padStart(15) + ((average / mean) * 100).toFixed(0).padStart(12) + "%",
    );
  }

  const shareActual = shareRows.map((r) => r.actual);
  const shareGuess = shareRows.map((r) => r.predicted);
  const shareMiss = shareGuess.map((g, i) => Math.abs(g - shareActual[i]!));
  const shareMean = shareActual.reduce((a, b) => a + b, 0) / shareActual.length;

  console.log("\nhow that afternoon was divided among them");
  console.log("  the average man took " + (shareMean * 100).toFixed(1) + "% of his offence\n");
  console.log("  the simulation            spearman " +
    spearman(shareGuess, shareActual).toFixed(4) +
    "   average miss " + (shareMiss.reduce((a, b) => a + b, 0) / shareMiss.length * 100).toFixed(1) +
    " points of share");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
