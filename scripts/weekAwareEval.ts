/**
 * The simulation gave a man the same number every week, and scored
 * exactly zero at telling which of his own weeks would be the good
 * one. Now it is told the game: who he plays, by how much his team is
 * favoured, what the game is expected to total, and the wind.
 *
 * The question is whether any of that shows up.
 *
 * Run: npx tsx scripts/weekAwareEval.ts
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
const RUNS = 200;

async function main(): Promise<void> {
  const positions = new Map<string, string>();
  const games = new Map<string, number>();

  for (const s of await loadPlayerStats(SCORE_ON - 1)) {
    positions.set(s.playerId, s.position);
    games.set(s.playerId, (games.get(s.playerId) ?? 0) + 1);
  }

  const { byTeam, playsByTeam } = await fitRoles(SCORE_ON - 1, positions, games);

  // how soft each defence was to each position, from the year before
  const allowed = new Map<string, { points: number; weeks: number }>();
  const schedule = await loadGames();
  const opponentOf = new Map<string, string>();
  const lineOf = new Map<string, { favouredBy: number; total: number; wind: number }>();

  for (const game of schedule) {
    if (game.week > 18) continue;
    for (const [team, other, sign] of [
      [game.homeTeamId, game.awayTeamId, 1],
      [game.awayTeamId, game.homeTeamId, -1],
    ] as [string, string, number][]) {
      opponentOf.set(`${game.season}|${game.week}|${team}`, other);
      lineOf.set(`${game.season}|${game.week}|${team}`, {
        favouredBy: (game.spreadLine ?? 0) * sign,
        total: game.totalLine ?? 45,
        wind: game.indoors ? 0 : (game.wind ?? 0),
      });
    }
  }

  for (const row of await loadPlayerStats(SCORE_ON - 1)) {
    if (row.week > 18) continue;
    const against = opponentOf.get(`${SCORE_ON - 1}|${row.week}|${row.teamId}`);
    if (!against) continue;
    const key = `${against}|${row.position}`;
    const own = allowed.get(key) ?? { points: 0, weeks: 0 };
    own.points += fantasyPoints(row.statLine, RULES);
    own.weeks++;
    allowed.set(key, own);
  }

  const leagueAllowed = new Map<string, number>();

  for (const position of ["RB", "WR", "TE"]) {
    const each = [...allowed].filter(([k]) => k.endsWith(position));
    leagueAllowed.set(
      position,
      each.reduce((a, [, v]) => a + v.points / Math.max(1, v.weeks), 0) / Math.max(1, each.length),
    );
  }

  const softness = (against: string, position: string) => {
    const own = allowed.get(`${against}|${position}`);
    const league = leagueAllowed.get(position) ?? 1;
    if (!own || own.weeks < 8 || league <= 0) return 1;
    // hold it close to 1; a season of points allowed is a noisy thing
    return 1 + ((own.points / own.weeks / league) - 1) * 0.5;
  };

  const rng = seededRng(31);
  const draws: Draws = { uniform: rng, normal: () => normalDraw(rng) };

  interface Row { playerId: string; week: number; actual: number; flat: number; aware: number }
  const rows: Row[] = [];
  const actualWeeks = new Map<string, Map<number, number>>();

  for (const row of await loadPlayerStats(SCORE_ON)) {
    if (row.week > 18) continue;
    const own = actualWeeks.get(row.playerId) ?? new Map<number, number>();
    own.set(row.week, fantasyPoints(row.statLine, RULES));
    actualWeeks.set(row.playerId, own);
  }

  for (const [team, roster] of byTeam) {
    const base = { plays: playsByTeam.get(team)! };

    for (let week = 1; week <= 18; week++) {
      const against = opponentOf.get(`${SCORE_ON}|${week}|${team}`);
      const line = lineOf.get(`${SCORE_ON}|${week}|${team}`);
      if (!against || !line) continue;

      const totals = { flat: roster.map(() => 0), aware: roster.map(() => 0) };

      for (const kind of ["flat", "aware"] as const) {
        for (let run = 0; run < RUNS; run++) {
          const world = kind === "flat"
            ? base
            : forGame(base, { ...line, opponent: 1 });

          simulateSituationalWeek(world, roster, draws).forEach((one, i) => {
            if (!one.played) return;
            const points = fantasyPoints(one, RULES);
            // a soft defence lifts him, and only in the aware run
            const lift = kind === "aware"
              ? softness(against, roster[i]!.position)
              : 1;
            totals[kind][i] = totals[kind][i]! + points * lift;
          });
        }
      }

      roster.forEach((role, i) => {
        const actual = actualWeeks.get(role.playerId)?.get(week);
        if (actual === undefined) return;
        rows.push({
          playerId: role.playerId, week, actual,
          flat: totals.flat[i]! / RUNS,
          aware: totals.aware[i]! / RUNS,
        });
      });
    }
  }

  const actual = rows.map((r) => r.actual);
  console.log(`${rows.length} player-weeks in ${SCORE_ON}\n`);
  console.log("across players                spearman   average miss");

  for (const [label, get] of [
    ["not knowing the game", (r: Row) => r.flat],
    ["knowing the game", (r: Row) => r.aware],
  ] as [string, (r: Row) => number][]) {
    const guess = rows.map(get);
    const miss = guess.map((g, i) => Math.abs(g - actual[i]!));
    console.log(
      label.padEnd(28) + spearman(guess, actual).toFixed(4).padStart(9) +
      (miss.reduce((a, b) => a + b, 0) / miss.length).toFixed(2).padStart(15),
    );
  }

  const byPlayer = new Map<string, Row[]>();
  for (const row of rows) byPlayer.set(row.playerId, [...(byPlayer.get(row.playerId) ?? []), row]);

  console.log("\nwithin one player               spearman   players");

  for (const [label, get] of [
    ["knowing the game", (r: Row) => r.aware],
  ] as [string, (r: Row) => number][]) {
    const scores: number[] = [];

    for (const weeks of byPlayer.values()) {
      if (weeks.length < 10) continue;
      const guess = weeks.map(get);
      if (new Set(guess.map((g) => g.toFixed(3))).size < 3) continue;
      scores.push(spearman(guess, weeks.map((w) => w.actual)));
    }

    console.log(
      label.padEnd(30) +
      (scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length)).toFixed(4).padStart(9) +
      String(scores.length).padStart(9),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
