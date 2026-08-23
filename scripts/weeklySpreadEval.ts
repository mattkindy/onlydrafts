/**
 * How wide a player's weeks really are, against how wide the board says.
 *
 * The board ships a band per player. This works out the same band from
 * what actually happened, so the two can be put side by side, and it
 * reports the spread of those bands across players as well as their
 * size, since a model can get the average width right and still give
 * everybody the same shape.
 *
 * Run: npx tsx scripts/weeklySpreadEval.ts [season]
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, scoringRules } from "../src/scoring/fantasyPoints.js";

const season = Number(process.argv[2] ?? 2025);
// only men worth drafting, since a fringe player's band is mostly zeroes
const floor = Number(process.argv[3] ?? 4);
const rules = scoringRules("standard");

const quantile = (sorted: number[], at: number) => {
  const spot = (sorted.length - 1) * at;
  const low = Math.floor(spot);
  const high = Math.ceil(spot);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (spot - low);
};

const spreadOf = (values: number[]) => {
  const middle = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(
    values.reduce((a, b) => a + (b - middle) ** 2, 0) / values.length,
  );
};

async function main(): Promise<void> {
  const board = JSON.parse(
    await readFile(
      join(import.meta.dirname, "..", "docs", "data", "board-2026.json"),
      "utf8",
    ),
  ) as { players: any[] };
  const byName = new Map(board.players.map((p) => [p.name, p]));

  const weeksOf = new Map<string, { position: string; points: number[] }>();

  for (const row of await loadPlayerStats(season)) {
    if (!["QB", "RB", "WR", "TE"].includes(row.position)) {
      continue;
    }

    const seen = weeksOf.get(row.playerName) ??
      { position: row.position, points: [] };
    seen.points.push(fantasyPoints(row.statLine, rules));
    weeksOf.set(row.playerName, seen);
  }

  const rows: {
    name: string; position: string; weeks: number;
    mean: number; realQ1: number; realQ3: number; realLow: number; realHigh: number;
    saidQ1: number; saidQ3: number; saidLow: number; saidHigh: number;
  }[] = [];

  for (const [name, seen] of weeksOf) {
    const said = byName.get(name);

    if (!said || !said.game || seen.points.length < 8) {
      continue;
    }

    const sorted = [...seen.points].sort((a, b) => a - b);
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;

    if (mean < floor) {
      continue;
    }

    rows.push({
      name, position: seen.position, weeks: sorted.length, mean,
      realQ1: quantile(sorted, 0.25), realQ3: quantile(sorted, 0.75),
      realLow: quantile(sorted, 0.1), realHigh: quantile(sorted, 0.9),
      saidQ1: said.game.q1, saidQ3: said.game.q3,
      saidLow: said.game.low, saidHigh: said.game.high,
    });
  }

  console.log(`${rows.length} players with eight weeks or more in ${season} averaging ${floor}+\n`);

  const asShare = (row: (typeof rows)[number]) => ({
    real: (row.realQ3 - row.realQ1) / row.mean,
    said: (row.saidQ3 - row.saidQ1) / (said(row) || 1),
    realTail: (row.realHigh - row.realLow) / row.mean,
    saidTail: (row.saidHigh - row.saidLow) / (said(row) || 1),
  });

  function said(row: (typeof rows)[number]): number {
    return byName.get(row.name)!.ppg;
  }

  console.log("the middle half, as a share of a player's own average");
  console.log("  group      n    really    board");

  for (const group of ["QB", "RB", "WR", "TE"]) {
    const inGroup = rows.filter((r) => r.position === group);

    if (!inGroup.length) {
      continue;
    }

    const shares = inGroup.map(asShare);
    const realMiddle = shares.reduce((a, s) => a + s.real, 0) / shares.length;
    const saidMiddle = shares.reduce((a, s) => a + s.said, 0) / shares.length;
    console.log(
      "  " + group.padEnd(8) + String(inGroup.length).padStart(4) +
      realMiddle.toFixed(2).padStart(10) + saidMiddle.toFixed(2).padStart(9),
    );
  }

  const shares = rows.map(asShare);
  console.log(
    "\n  everyone" + String(rows.length).padStart(4) +
    (shares.reduce((a, s) => a + s.real, 0) / shares.length).toFixed(2).padStart(10) +
    (shares.reduce((a, s) => a + s.said, 0) / shares.length).toFixed(2).padStart(9),
  );
  console.log(
    "\nthe tenth to ninetieth, same way" +
    "\n  everyone" + String(rows.length).padStart(4) +
    (shares.reduce((a, s) => a + s.realTail, 0) / shares.length).toFixed(2).padStart(10) +
    (shares.reduce((a, s) => a + s.saidTail, 0) / shares.length).toFixed(2).padStart(9),
  );

  // whether players differ from each other, not only whether the
  // average width is right
  console.log(
    "\nhow much those widths differ from player to player" +
    "\n  really " + spreadOf(shares.map((s) => s.real)).toFixed(3) +
    "\n  board  " + spreadOf(shares.map((s) => s.said)).toFixed(3),
  );

  const widest = [...rows]
    .sort((a, b) => (b.realQ3 - b.realQ1) / b.mean - (a.realQ3 - a.realQ1) / a.mean);
  console.log("\nwidest and narrowest weeks in truth, with what the board said");
  console.log("  player                pos   ppg   really          board");

  for (const row of [...widest.slice(0, 6), ...widest.slice(-6)]) {
    console.log(
      "  " + row.name.padEnd(21) + row.position.padEnd(5) +
      row.mean.toFixed(1).padStart(5) +
      `   ${row.realQ1.toFixed(1)} to ${row.realQ3.toFixed(1)}`.padEnd(16) +
      `${row.saidQ1.toFixed(1)} to ${row.saidQ3.toFixed(1)}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
