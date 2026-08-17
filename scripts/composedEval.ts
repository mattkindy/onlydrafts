/**
 * The two halves put together.
 *
 * Sizing an afternoon and dividing it are different problems and the
 * measurements said so: carrying a belief about an offence week to
 * week ranks team output at .37, while the simulation ranks it at .14
 * and is beaten by a constant. The simulation divides well, at .53.
 *
 * So take the size from one and the split from the other.
 *
 * Run: npx tsx scripts/composedEval.ts
 */

import { loadGames, loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { spearman } from "../src/backtest/metrics.js";
import { seededRng } from "../src/sim/rng.js";
import { normalDraw } from "../src/sim/normal.js";
import { fitRoles } from "../src/features/fitRoles.js";
import { forGame, simulateSituationalWeek } from "../src/model/situationalWeek.js";
import {
  afterTeamWeek, carryToNextSeason, expectTeamWeek, unknownTeam, type TeamBelief,
} from "../src/model/teamState.js";
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
    if (game.week > 18) continue;
    for (const [team, sign] of [
      [game.homeTeamId, 1], [game.awayTeamId, -1],
    ] as [string, number][]) {
      lineOf.set(`${game.season}|${game.week}|${team}`, {
        favouredBy: (game.spreadLine ?? 0) * sign,
        total: game.totalLine ?? 45,
        wind: game.indoors ? 0 : (game.wind ?? 0),
      });
    }
  }

  const teamScored = new Map<string, number>();
  const playerScored = new Map<string, number>();

  for (const season of [SCORE_ON - 1, SCORE_ON]) {
    for (const row of await loadPlayerStats(season)) {
      if (row.week > 18 || !["RB", "WR", "TE"].includes(row.position)) continue;
      const points = fantasyPoints(row.statLine, RULES);
      teamScored.set(
        `${season}|${row.week}|${row.teamId}`,
        (teamScored.get(`${season}|${row.week}|${row.teamId}`) ?? 0) + points,
      );

      if (season === SCORE_ON) {
        playerScored.set(`${row.playerId}|${row.week}`, points);
      }
    }
  }

  // build each offence's belief through 2024, then run 2025 forward
  const teams = [...byTeam.keys()];
  const belief = new Map<string, TeamBelief>(teams.map((t) => [t, unknownTeam()]));

  for (let week = 1; week <= 18; week++) {
    for (const team of teams) {
      const actual = teamScored.get(`${SCORE_ON - 1}|${week}|${team}`);
      const line = lineOf.get(`${SCORE_ON - 1}|${week}|${team}`);
      if (actual === undefined || !line) continue;
      belief.set(team, afterTeamWeek(belief.get(team)!, actual, line.total));
    }
  }

  for (const team of teams) {
    belief.set(team, carryToNextSeason(belief.get(team)!));
  }

  const rng = seededRng(19);
  const draws: Draws = { uniform: rng, normal: () => normalDraw(rng) };
  interface Row { actual: number; raw: number; composed: number }
  const rows: Row[] = [];

  for (let week = 1; week <= 18; week++) {
    for (const [team, roster] of byTeam) {
      const line = lineOf.get(`${SCORE_ON}|${week}|${team}`);
      if (!line) continue;

      const world = forGame({ plays: playsByTeam.get(team)! }, { ...line, opponent: 1 });
      const perPlayer = roster.map(() => 0);
      let simTotal = 0;

      for (let run = 0; run < RUNS; run++) {
        simulateSituationalWeek(world, roster, draws).forEach((one, i) => {
          if (!one.played) return;
          const points = fantasyPoints(one, RULES);
          perPlayer[i] = perPlayer[i]! + points;
          simTotal += points;
        });
      }

      const expected = expectTeamWeek(belief.get(team)!, line.total);
      const simMean = simTotal / RUNS;

      roster.forEach((role, i) => {
        const actual = playerScored.get(`${role.playerId}|${week}`);
        if (actual === undefined || simMean <= 0) return;
        const raw = perPlayer[i]! / RUNS;
        rows.push({ actual, raw, composed: (raw / simMean) * expected });
      });
    }

    // fold the week in before moving to the next
    for (const team of teams) {
      const actual = teamScored.get(`${SCORE_ON}|${week}|${team}`);
      const line = lineOf.get(`${SCORE_ON}|${week}|${team}`);
      if (actual === undefined || !line) continue;
      belief.set(team, afterTeamWeek(belief.get(team)!, actual, line.total));
    }
  }

  const actual = rows.map((r) => r.actual);
  console.log(`${rows.length} player-weeks in ${SCORE_ON}\n`);
  console.log("model                            spearman   average miss");

  for (const [label, get] of [
    ["the simulation on its own", (r: Row) => r.raw],
    ["its split, the state's size", (r: Row) => r.composed],
  ] as [string, (r: Row) => number][]) {
    const guess = rows.map(get);
    const miss = guess.map((g, i) => Math.abs(g - actual[i]!));
    console.log(
      label.padEnd(32) + spearman(guess, actual).toFixed(4).padStart(9) +
      (miss.reduce((a, b) => a + b, 0) / miss.length).toFixed(2).padStart(15),
    );
  }

  console.log("\nfor reference, the weekly ridge ranks .624 and misses by 3.70");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
