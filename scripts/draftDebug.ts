// Prints each drafted roster with 2024 actual points per game, to
// check the league draft for bugs. Run: npx tsx scripts/draftDebug.ts

import { loadGames, loadPlayerStats } from "../src/data/nflverse.js";
import { weeklyExamplesForSeason } from "../src/features/weeklyModel.js";
import { summarizeSeason } from "../src/features/seasonSummary.js";
import { presets } from "../src/scoring/fantasyPoints.js";

const TEAMS = 12;
const ROSTER_LIMITS: Record<string, number> = { QB: 2, RB: 4, WR: 4, TE: 2 };
const ROSTER_SIZE = 10;

function snakeOrder(round: number, teams: number): number[] {
  const order = Array.from({ length: teams }, (_, i) => i);
  return round % 2 === 0 ? order : order.reverse();
}

const games = await loadGames();
const season = await weeklyExamplesForSeason(2024, games);
const actual = summarizeSeason(await loadPlayerStats(2024), presets.ppr);
const preseason = new Map<string, { position: string; value: number; name: string }>();

for (const e of season) {
  const existing = preseason.get(e.playerId);
  if (!existing || e.prevPpg > existing.value) {
    preseason.set(e.playerId, { position: e.position, value: e.prevPpg, name: e.playerName });
  }
}

const board = [...preseason.entries()]
  .map(([playerId, v]) => ({ playerId, ...v }))
  .sort((a, b) => b.value - a.value);

const rosters: Set<string>[] = Array.from({ length: TEAMS }, () => new Set());
const counts = Array.from({ length: TEAMS }, () => new Map<string, number>());
let cursor = 0;

for (let round = 0; round < ROSTER_SIZE; round++) {
  for (const team of snakeOrder(round, TEAMS)) {
    while (cursor < board.length) {
      const player = board[cursor]!;
      const have = counts[team]!.get(player.position) ?? 0;
      const taken = rosters.some((r) => r.has(player.playerId));

      if (!taken && have < (ROSTER_LIMITS[player.position] ?? 0)) {
        rosters[team]!.add(player.playerId);
        counts[team]!.set(player.position, have + 1);
        break;
      }

      cursor++;
    }

    cursor = 0;
  }
}

for (let team = 0; team < 3; team++) {
  const players = [...rosters[team]!].map((id) => {
    const p = preseason.get(id)!;
    const a = actual.get(id);
    return `${p.name}(${p.position} prev ${p.value.toFixed(1)} now ${(a?.pointsPerGame ?? 0).toFixed(1)})`;
  });
  console.log(`team ${team}: ${players.join(", ")}\n`);
}
