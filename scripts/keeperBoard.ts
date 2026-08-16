// Works out who each team keeps by surplus over the pick it costs,
// then reprices the draft pool with replacement levels set by what
// actually survives the keeper round.
// Run: npx tsx scripts/keeperBoard.ts

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { normalizeName } from "../src/data/names.js";

const TEAMS = 12;
const KEEPERS = 3;
const STARTERS = { QB: 12, RB: 23, WR: 35, TE: 14 };

interface BoardPlayer {
  name: string;
  key: string;
  position: string;
  team: string;
  ppg: number;
  vor: number;
  adp: number | null;
  game: { ev: number; q1: number; q3: number };
}

const pickOfRound = (round: number) => (round - 1) * TEAMS + TEAMS / 2;

async function main(): Promise<void> {
  const board = JSON.parse(
    await readFile(
      join(import.meta.dirname, "..", "docs", "weekly", "data", "board-2026.json"),
      "utf8",
    ),
  ) as { players: BoardPlayer[] };
  const byKey = new Map(board.players.map((p) => [p.key, p]));
  const look = (name: string) => {
    const key = normalizeName(name);
    return (
      byKey.get(key) ??
      board.players.find((p) => p.key.includes(key) || key.includes(p.key))
    );
  };

  const rows = parseCsv(
    await readFile(
      join(import.meta.dirname, "..", "data", "curated", "keepers2026.csv"),
      "utf8",
    ),
  );

  const byTeam = new Map<string, { player: BoardPlayer; cost: number; surplus: number }[]>();

  for (const row of rows) {
    const player = look(row["player"] ?? "");

    if (!player || player.adp === null) {
      continue;
    }

    const listed = Number(row["cost"]);
    const adpRound = Math.ceil(player.adp / TEAMS);
    // a consecutive keep costs the earlier of its listed round and this
    // year's market round, so the market can erase the discount
    const costRound = row["consecutive"] === "1" ? Math.min(listed, adpRound) : listed;
    const entry = {
      player,
      cost: costRound,
      surplus: pickOfRound(costRound) - player.adp,
    };
    const list = byTeam.get(row["team"] ?? "") ?? [];
    list.push(entry);
    byTeam.set(row["team"] ?? "", list);
  }

  const kept = new Set<string>();
  console.log("who keeps whom, by surplus over the pick it costs:\n");

  for (const [team, list] of byTeam) {
    const best = list.sort((a, b) => b.surplus - a.surplus).slice(0, KEEPERS);

    for (const k of best) {
      kept.add(k.player.key);
    }

    console.log(
      (team === "kindy" ? "YOU " : "    ") + team.padEnd(10) +
        best
          .map(
            (k) =>
              `${k.player.name} (${k.player.position}, r${k.cost} for a pick-${k.player.adp?.toFixed(0)} player)`,
          )
          .join(", "),
    );
  }

  const pool = board.players
    .filter((p) => !kept.has(p.key))
    .sort((a, b) => b.ppg - a.ppg);

  console.log("\nreplacement level once keepers are gone:");
  console.log("pos  full pool  after keepers  change");

  const newReplacement: Record<string, number> = {};

  for (const [position, rank] of Object.entries(STARTERS)) {
    const all = board.players
      .filter((p) => p.position === position)
      .sort((a, b) => b.ppg - a.ppg);
    const left = pool.filter((p) => p.position === position);
    const before = all[rank - 1]?.ppg ?? 0;
    const after = left[rank - 1]?.ppg ?? 0;
    newReplacement[position] = after;
    console.log(
      position.padEnd(4) + before.toFixed(1).padStart(9) + after.toFixed(1).padStart(14) +
        ("  " + (after - before).toFixed(1)).padStart(8),
    );
  }

  const repriced = pool
    .map((p) => ({ p, vor: p.ppg - (newReplacement[p.position] ?? 0) }))
    .sort((a, b) => b.vor - a.vor);

  console.log("\nbest available, repriced against the thinned pool:");

  repriced.slice(0, 16).forEach(({ p, vor }, i) => {
    console.log(
      String(i + 1).padStart(3) + " " + p.name.padEnd(20) + p.position.padEnd(3) +
        p.game.ev.toFixed(1).padStart(6) + "/g  vor " + vor.toFixed(1).padStart(5) +
        "  adp " + (p.adp?.toFixed(0) ?? "-"),
    );
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
