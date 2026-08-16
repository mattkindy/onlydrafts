/**
 * Points are a summary. A model that gets them right by handing out
 * yards where the real player got touchdowns is still wrong, and the
 * error shows the moment a league changes its scoring.
 *
 * So score the line itself. The flat model cannot enter, because it
 * only ever produced a number.
 *
 * Run: npx tsx scripts/statLineEval.ts
 */

import { loadPlayerStats } from "../src/data/nflverse.js";
import { seededRng } from "../src/sim/rng.js";
import { normalDraw } from "../src/sim/normal.js";
import { fitRoles } from "../src/features/fitRoles.js";
import { simulateSituationalWeek } from "../src/model/situationalWeek.js";
import type { Draws, PlayerLine } from "../src/model/playerWeek.js";

const FIT_ON = 2024;
const SCORE_ON = 2025;
const RUNS = 120;

interface Line {
  receptions: number; recYds: number; rushYds: number; scores: number;
}

const flatten = (line: PlayerLine): Line => ({
  receptions: line.receptions, recYds: line.recYds,
  rushYds: line.rushYds, scores: line.recTd + line.rushTd,
});

function shapeOf(lines: Line[]) {
  const mean = (get: (l: Line) => number) =>
    lines.reduce((a, l) => a + get(l), 0) / Math.max(1, lines.length);
  const share = (test: (l: Line) => boolean) =>
    lines.filter(test).length / Math.max(1, lines.length);

  return {
    receptions: mean((l) => l.receptions),
    recYds: mean((l) => l.recYds),
    rushYds: mean((l) => l.rushYds),
    scores: mean((l) => l.scores),
    hundredYards: share((l) => l.recYds + l.rushYds >= 100),
    multiScore: share((l) => l.scores >= 2),
    blank: share((l) => l.recYds + l.rushYds < 20 && l.scores === 0),
  };
}

async function main(): Promise<void> {
  const positions = new Map<string, string>();
  const games = new Map<string, number>();

  for (const s of await loadPlayerStats(FIT_ON)) {
    positions.set(s.playerId, s.position);
    games.set(s.playerId, (games.get(s.playerId) ?? 0) + 1);
  }

  const { byTeam, playsByTeam } = await fitRoles(FIT_ON, positions, games);
  const swingArg = process.argv.indexOf("--swing");
  // no flag means use what fitRoles decided
  const swings: (number | null)[] = swingArg === -1
    ? [null]
    : (process.argv[swingArg + 1] ?? "").split(",").map(Number);
  for (const swing of swings) {
  const rng = seededRng(91);
  const draws: Draws = { uniform: rng, normal: () => normalDraw(rng) };
  const simulated = new Map<string, Line[]>();

  for (const [team, rawRoster] of byTeam) {
    const roster = swing === null
      ? rawRoster
      : rawRoster.map((r) => ({ ...r, yardSwing: swing }));
    const plays = playsByTeam.get(team)!;

    for (let run = 0; run < RUNS; run++) {
      simulateSituationalWeek({ plays }, roster, draws).forEach((line, i) => {
        // the stats file only has rows for games a man played, so a
        // week he sat out has no counterpart to compare against
        if (!line.played) {
          return;
        }

        const id = roster[i]!.playerId;
        simulated.set(id, [...(simulated.get(id) ?? []), flatten(line)]);
      });
    }
  }

  const real = new Map<string, Line[]>();

  for (const row of await loadPlayerStats(SCORE_ON)) {
    if (row.week > 18 || !simulated.has(row.playerId)) continue;
    real.set(row.playerId, [...(real.get(row.playerId) ?? []), {
      receptions: row.statLine.receptions ?? 0,
      recYds: row.statLine.recYds ?? 0,
      rushYds: row.statLine.rushYds ?? 0,
      scores: (row.statLine.recTd ?? 0) + (row.statLine.rushTd ?? 0),
    }]);
  }

  const ids = [...real].filter(([, weeks]) => weeks.length >= 10).map(([id]) => id);
  const actual = shapeOf(ids.flatMap((id) => real.get(id) ?? []));
  const model = shapeOf(ids.flatMap((id) => simulated.get(id) ?? []));

  if (swings.length > 1) {
    console.log(`\nyard swing ${swing?.toFixed(2)}`);
  } else {
    console.log(`${ids.length} players, roles from ${FIT_ON}, weeks from ${SCORE_ON}\n`);
  }

  console.log("stat                    actual   simulated   off by");

  for (const [label, key, decimals] of [
    ["catches a game", "receptions", 2],
    ["yards through air", "recYds", 1],
    ["yards on ground", "rushYds", 1],
    ["scores a game", "scores", 3],
    ["100 yard games", "hundredYards", 3],
    ["two score games", "multiScore", 4],
    ["games under 20 yards", "blank", 3],
  ] as [string, keyof typeof actual, number][]) {
    const off = actual[key] > 0 ? (model[key] / actual[key] - 1) * 100 : 0;
    console.log(
      label.padEnd(22) + actual[key].toFixed(decimals).padStart(9) +
      model[key].toFixed(decimals).padStart(12) +
      ((off >= 0 ? "+" : "") + off.toFixed(0) + "%").padStart(9),
    );
  }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
