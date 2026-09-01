/**
 * Where we put every kicker and defence against where the room does.
 *
 * The group is placed at the room's picks, so the only thing left to
 * disagree about is the order inside the group. This prints that.
 *
 * Run: npx tsx scripts/checkKickersAndDefences.ts
 */

import { readFileSync } from "node:fs";

import { rescore } from "../app/lib/board.ts";
import type { Player } from "../app/lib/scoring.ts";

const file = JSON.parse(
  readFileSync("docs/data/board-2026.json", "utf8"),
) as { players: Record<string, unknown>[] };

const players = file.players.map((row) => ({
  name: row["name"], key: row["key"], position: row["position"],
  team: row["team"] ?? null,
  projected: row["projected"] ?? null, simulated: row["simulated"] ?? null,
  weeks: row["weeks"] ?? [], adp: row["adp"] ?? null,
  adpLow: row["adpLow"] ?? null, adpHigh: row["adpHigh"] ?? null,
  adpBy: row["adpBy"] ?? null, bye: row["bye"] ?? null,
  touches: row["touches"] ?? null, rookie: row["rookie"] ?? false,
  game: row["game"] ?? null, sim: row["sim"] ?? null, ppg: row["ppg"] ?? 0,
})) as unknown as Player[];

const HALF_PPR = {
  rec: 0.5, rec_yd: 0.1, rec_td: 6, rush_yd: 0.1, rush_td: 6,
  pass_yd: 0.04, pass_td: 4, int: -2, fum_lost: -2,
};

const SLOTS = ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF"];

const men = rescore(players, { teams: 12, slots: SLOTS, pays: HALF_PPR });

for (const where of ["DEF", "K"]) {
  const its = men
    .filter((p) => p.position === where)
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));

  console.log(`\n${where}: ours in order, against where the room prices him\n`);

  its.slice(0, 16).forEach((p, i) => {
    console.log(
      `  ${String(i + 1).padStart(2)}. ${p.name.padEnd(22)}` +
      ` ppg ${(p.ppg ?? 0).toFixed(1).padStart(5)}` +
      ` our pick ${String(p.rank ?? "-").padStart(4)}` +
      ` room ${p.adp ? p.adp.toFixed(0).padStart(4) : "   -"}`,
    );
  });
}
