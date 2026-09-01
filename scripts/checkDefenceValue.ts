/**
 * What number a defence card actually shows, and how many defences
 * come out above nothing.
 *
 * Skill players have their value replaced by what a pick at their place
 * on the board is worth. Kickers and defences keep their own, so the
 * two are not the same measure even though the card labels them alike.
 *
 * Run: npx tsx scripts/checkDefenceValue.ts
 */

import { readFileSync } from "node:fs";

import { rescore } from "../app/lib/board.ts";
import { offWaivers } from "../app/lib/replacementPool.ts";
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
    .sort((a, b) => (b.ownVor ?? 0) - (a.ownVor ?? 0));
  const lastStarter = its[12]?.ppg ?? 0;
  const waivers = offWaivers(men, where, 12, null) ?? 0;

  console.log(`\n${where}: ${its.length} on the board`);
  console.log(
    `  last starter ${lastStarter.toFixed(2)} a game,` +
    ` best off waivers ${waivers.toFixed(2)} a game\n`,
  );

  for (const p of its.slice(0, 12)) {
    console.log(
      `  ${p.name.padEnd(20)} ppg ${(p.ppg ?? 0).toFixed(1).padStart(5)}` +
      ` par ${(p.ownVor ?? 0).toFixed(1).padStart(7)}` +
      ` our pick ${String(p.rank ?? "-").padStart(4)}` +
      ` room ${p.adp ? p.adp.toFixed(0).padStart(4) : "   -"}`,
    );
  }
}

/** what a skill player at the same board position is worth, for scale */
const nearby = men
  .filter((p) => !["K", "DEF"].includes(p.position) && (p.rank ?? 0) >= 120 &&
    (p.rank ?? 0) <= 175)
  .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));

console.log("\nskill players over the same stretch of the board\n");

for (const p of nearby.slice(0, 8)) {
  console.log(
    `  ${p.position.padEnd(3)} ${p.name.padEnd(22)}` +
    ` value ${(p.vor ?? 0).toFixed(1).padStart(7)}` +
    ` our pick ${String(p.rank).padStart(4)}`,
  );
}
