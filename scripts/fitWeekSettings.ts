/**
 * Fits the two numbers still set by eye: how much the count of snaps
 * in a situation swings from week to week, and how many touches it
 * takes before a man's own scoring rate is believed over the league's.
 *
 * Scored against how often the real weeks were big, quiet, or ended in
 * the end zone, on a season neither number was fitted on.
 *
 * Run: npx tsx scripts/fitWeekSettings.ts
 */

import { loadPlayerStats } from "../src/data/nflverse.js";
import { seededRng } from "../src/sim/rng.js";
import { normalDraw } from "../src/sim/normal.js";
import { fitRoles } from "../src/features/fitRoles.js";
import {
  FIRMNESS, simulateSituationalWeek, type WeekSettings,
} from "../src/model/situationalWeek.js";
import type { Draws, PlayerLine } from "../src/model/playerWeek.js";

const FIT_ON = 2024;
const SCORE_ON = 2025;
const RUNS = 100;

interface Shape { hundred: number; blank: number; scores: number; yards: number }

function shapeOf(lines: { yards: number; scores: number }[]): Shape {
  const share = (test: (l: { yards: number; scores: number }) => boolean) =>
    lines.filter(test).length / Math.max(1, lines.length);

  return {
    hundred: share((l) => l.yards >= 100),
    blank: share((l) => l.yards < 20 && l.scores === 0),
    scores: lines.reduce((a, l) => a + l.scores, 0) / Math.max(1, lines.length),
    yards: lines.reduce((a, l) => a + l.yards, 0) / Math.max(1, lines.length),
  };
}

const flatten = (line: PlayerLine) => ({
  yards: line.recYds + line.rushYds,
  scores: line.recTd + line.rushTd,
});

async function main(): Promise<void> {
  const positions = new Map<string, string>();
  const games = new Map<string, number>();

  for (const s of await loadPlayerStats(FIT_ON)) {
    positions.set(s.playerId, s.position);
    games.set(s.playerId, (games.get(s.playerId) ?? 0) + 1);
  }

  const real = new Map<string, { yards: number; scores: number }[]>();

  for (const row of await loadPlayerStats(SCORE_ON)) {
    if (row.week > 18) continue;
    real.set(row.playerId, [...(real.get(row.playerId) ?? []), {
      yards: (row.statLine.recYds ?? 0) + (row.statLine.rushYds ?? 0),
      scores: (row.statLine.recTd ?? 0) + (row.statLine.rushTd ?? 0),
    }]);
  }

  console.log("usage trust   scoring trust   100 yard   quiet   scores   yards");

  for (const usage of [2, 6, 12, 25, 50]) {
    for (const scoring of [2]) {
      const playSwing = 0.3;
      const { byTeam, playsByTeam } = await fitRoles(
        FIT_ON, positions, games, 17, { usage, scoring },
      );
      const rng = seededRng(91);
      const draws: Draws = { uniform: rng, normal: () => normalDraw(rng) };
      const settings: WeekSettings = { firmness: FIRMNESS, playSwing };
      const simulated = new Map<string, { yards: number; scores: number }[]>();

      for (const [team, roster] of byTeam) {
        const plays = playsByTeam.get(team)!;

        for (let run = 0; run < RUNS; run++) {
          simulateSituationalWeek({ plays }, roster, draws, settings)
            .forEach((line, i) => {
              if (!line.played) return;
              const id = roster[i]!.playerId;
              simulated.set(id, [...(simulated.get(id) ?? []), flatten(line)]);
            });
        }
      }

      const ids = [...real]
        .filter(([id, weeks]) => weeks.length >= 10 && simulated.has(id))
        .map(([id]) => id);
      const actual = shapeOf(ids.flatMap((id) => real.get(id)!));
      const model = shapeOf(ids.flatMap((id) => simulated.get(id)!));
      const off = (a: number, b: number) =>
        ((b / a - 1) * 100 >= 0 ? "+" : "") + ((b / a - 1) * 100).toFixed(0) + "%";

      console.log(
        String(usage).padEnd(14) + String(scoring).padEnd(16) +
        off(actual.hundred, model.hundred).padStart(9) +
        off(actual.blank, model.blank).padStart(8) +
        off(actual.scores, model.scores).padStart(9) +
        off(actual.yards, model.yards).padStart(8),
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
