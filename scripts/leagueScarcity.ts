// Reads a Sleeper league, guesses each rival's keepers by our own
// values, and reports how thin each position gets after they come off.
// Run: npx tsx scripts/leagueScarcity.ts <leagueId> <sleeperUser>

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeName } from "../src/data/names.js";

const api = (path: string) =>
  fetch("https://api.sleeper.app/v1" + path).then((r) => r.json());

interface BoardPlayer {
  name: string;
  key: string;
  position: string;
  team: string;
  ppg: number;
  vor: number;
  game: { ev: number; q1: number; q3: number };
}

async function main(): Promise<void> {
  const leagueId = process.argv[2]!;
  const username = process.argv[3]!;
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

  const [league, rosters, users, players] = await Promise.all([
    api("/league/" + leagueId),
    api("/league/" + leagueId + "/rosters"),
    api("/league/" + leagueId + "/users"),
    api("/players/nfl"),
  ]);

  const me = (await api("/user/" + username)).user_id;
  const nameOf = new Map<string, string>(
    users.map((u: { user_id: string; display_name: string }) => [u.user_id, u.display_name]),
  );
  const keepers = league.settings?.max_keepers ?? 3;
  const slots: string[] = league.roster_positions ?? [];

  console.log(league.name + ": " + rosters.length + " teams, " + keepers + " keepers each");
  console.log("starting slots: " + slots.filter((s) => s !== "BN").join(", ") + "\n");

  const likely: BoardPlayer[] = [];

  console.log("who each team probably keeps, by our values:");

  for (const roster of rosters) {
    const owner = nameOf.get(roster.owner_id) ?? roster.owner_id;
    const ranked = (roster.players ?? [])
      .map((id: string) => players[id])
      .filter((p: { full_name?: string } | undefined) => p && p.full_name)
      .map((p: { full_name: string }) => look(p.full_name))
      .filter((p: BoardPlayer | undefined): p is BoardPlayer => !!p)
      .sort((a: BoardPlayer, b: BoardPlayer) => b.vor - a.vor);
    const kept = ranked.slice(0, keepers);
    likely.push(...kept);
    console.log(
      "  " + (owner === nameOf.get(me) ? "YOU  " : "     ") + owner.padEnd(16) +
        kept.map((p: BoardPlayer) => p.name + " (" + p.position + " " + p.vor.toFixed(1) + ")").join(", "),
    );
  }

  const gone = new Set(likely.map((p) => p.key));
  const positions = ["QB", "RB", "WR", "TE"];

  console.log("\nwhat is left at each position, in points a game:");
  console.log("pos  kept  best  5th   10th  20th  drop 1st to 10th");

  for (const position of positions) {
    const pool = board.players
      .filter((p) => p.position === position && !gone.has(p.key))
      .sort((a, b) => b.ppg - a.ppg);
    const at = (i: number) => (pool[i] ? pool[i]!.ppg.toFixed(1) : "-");
    const keptCount = likely.filter((p) => p.position === position).length;
    const drop = pool[0] && pool[9] ? (pool[0]!.ppg - pool[9]!.ppg).toFixed(1) : "-";
    console.log(
      position.padEnd(4) + String(keptCount).padStart(4) + "  " +
        at(0).padStart(4) + "  " + at(4).padStart(4) + "  " + at(9).padStart(4) + "  " +
        at(19).padStart(4) + "  " + drop.padStart(4),
    );
  }

  console.log("\nbest available around your picks, if the keepers above hold:");
  const pool = board.players
    .filter((p) => !gone.has(p.key))
    .sort((a, b) => b.vor - a.vor);

  for (const pick of [3, 27, 39, 51, 63, 75]) {
    const window = pool.slice(Math.max(0, pick - 4), pick + 2);
    console.log(
      "  pick " + String(pick).padStart(3) + ": " +
        window.map((p) => p.name + " (" + p.position + ")").join(", "),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
