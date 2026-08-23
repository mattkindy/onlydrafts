/**
 * Works out who each team keeps by surplus over the pick it costs, then
 * reprices the draft pool against the players who survive the keeper
 * round. Replacement level comes from the same code the board uses, so
 * the two cannot disagree.
 *
 * Run: npx tsx scripts/keeperBoard.ts --league <sleeper id>
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { normalizeName } from "../src/data/names.js";
import { fetchStarterSlots } from "../src/data/leagueScoring.js";
import { DEFAULT_SLOTS, replacementLevels } from "../src/features/replacement.js";

const KEEPERS = 3;

interface BoardPlayer {
  name: string;
  key: string;
  position: string;
  ppg: number;
  adp: number | null;
  game: { ev: number; q1: number; q3: number };
}

function argOf(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1]!;
}

async function main(): Promise<void> {
  const leagueId = argOf("--league", "");
  const slots = leagueId ? await fetchStarterSlots(leagueId) : DEFAULT_SLOTS;

  if (!leagueId) {
    console.warn(
      "no --league given, so this uses a generic 12-team lineup " +
        "rather than your league's\n",
    );
  }

  const board = JSON.parse(
    await readFile(
      join(import.meta.dirname, "..", "docs", "data", "board-2026.json"),
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
  const pickOfRound = (round: number) =>
    (round - 1) * slots.teams + slots.teams / 2;

  const rows = parseCsv(
    await readFile(
      join(import.meta.dirname, "..", "data", "curated", "keepers2026.csv"),
      "utf8",
    ),
  );

  const byTeam = new Map<
    string,
    { player: BoardPlayer; cost: number; surplus: number }[]
  >();

  for (const row of rows) {
    const player = look(row["player"] ?? "");

    if (!player || player.adp === null) {
      continue;
    }

    const listed = Number(row["cost"]);
    const adpRound = Math.ceil(player.adp / slots.teams);
    // a consecutive keep costs the earlier of its listed round and this
    // year's market round, so the market can erase the discount
    const cost = row["consecutive"] === "1" ? Math.min(listed, adpRound) : listed;
    const list = byTeam.get(row["team"] ?? "") ?? [];
    list.push({ player, cost, surplus: pickOfRound(cost) - player.adp });
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
      team.padEnd(10) +
        best
          .map(
            (k) =>
              `${k.player.name} (${k.player.position}, r${k.cost} for a ` +
              `pick-${k.player.adp?.toFixed(0)} player)`,
          )
          .join(", "),
    );
  }

  const pool = board.players.filter((p) => !kept.has(p.key));
  const full = replacementLevels(board.players, slots);
  const thinned = replacementLevels(pool, slots);

  console.log("\nreplacement level, before and after the keeper round:");
  console.log("pos  everyone  after keepers  change  starters");

  for (const position of Object.keys(thinned.levels)) {
    const before = full.levels[position]!;
    const after = thinned.levels[position]!;
    console.log(
      position.padEnd(4) +
        before.toFixed(1).padStart(8) +
        after.toFixed(1).padStart(14) +
        ("  " + (after - before).toFixed(1)).padStart(8) +
        String(thinned.starters[position]).padStart(10),
    );
  }

  const repriced = pool
    .map((p) => ({ p, vor: p.ppg - thinned.levels[p.position]! }))
    .sort((a, b) => b.vor - a.vor);

  console.log("\nbest available, repriced against the thinned pool:");

  repriced.slice(0, 16).forEach(({ p, vor }, i) => {
    console.log(
      String(i + 1).padStart(3) +
        " " +
        p.name.padEnd(20) +
        p.position.padEnd(3) +
        p.game.ev.toFixed(1).padStart(6) +
        "/g  vor " +
        vor.toFixed(1).padStart(5) +
        "  adp " +
        (p.adp?.toFixed(0) ?? "-"),
    );
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
