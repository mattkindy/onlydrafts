/**
 * Where each position lands on the board a drafter actually reads.
 *
 * The question is whether kickers, defences and quarterbacks sit
 * earlier than a room would take them. So this rescores the shipped
 * board the way the page does, then prints how many of each position
 * fall in each block of picks next to how many the market takes there.
 *
 * Run: npx tsx scripts/checkPositionHeight.ts
 */

import { readFileSync } from "node:fs";

import { rescore } from "../app/lib/board.ts";
import type { Player } from "../app/lib/scoring.ts";

const file = JSON.parse(
  readFileSync("docs/data/board-2026.json", "utf8"),
) as { players: Record<string, unknown>[] };

const players = file.players.map((row) => ({
  name: row["name"],
  key: row["key"],
  position: row["position"],
  team: row["team"] ?? null,
  projected: row["projected"] ?? null,
  simulated: row["simulated"] ?? null,
  weeks: row["weeks"] ?? [],
  adp: row["adp"] ?? null,
  adpLow: row["adpLow"] ?? null,
  adpHigh: row["adpHigh"] ?? null,
  adpBy: row["adpBy"] ?? null,
  bye: row["bye"] ?? null,
  touches: row["touches"] ?? null,
  rookie: row["rookie"] ?? false,
  game: row["game"] ?? null,
  sim: row["sim"] ?? null,
  ppg: row["ppg"] ?? 0,
})) as unknown as Player[];

const HALF_PPR = {
  rec: 0.5, rec_yd: 0.1, rec_td: 6,
  rush_yd: 0.1, rush_td: 6,
  pass_yd: 0.04, pass_td: 4, int: -2, fum_lost: -2,
};

const SLOTS = ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF"];

const men = rescore(players, { teams: 12, slots: SLOTS, pays: HALF_PPR });

const BLOCKS = [
  ["1 to 24", 1, 24],
  ["25 to 60", 25, 60],
  ["61 to 96", 61, 96],
  ["97 to 132", 97, 132],
  ["133 to 180", 133, 180],
] as const;

const WHERE = ["QB", "RB", "WR", "TE", "K", "DEF"];

const countIn = (
  from: number, to: number, place: (p: Player) => number | null | undefined,
) => {
  const tally: Record<string, number> = {};

  for (const p of men) {
    const at = place(p);

    if (at != null && at >= from && at <= to) {
      tally[p.position] = (tally[p.position] ?? 0) + 1;
    }
  }

  return tally;
};

console.log("ours, then what the room takes in the same block\n");
console.log(["picks".padEnd(11), ...WHERE.map((w) => w.padStart(9))].join(""));

for (const [label, from, to] of BLOCKS) {
  const ours = countIn(from, to, (p) => p.rank);
  const room = countIn(from, to, (p) => p.adpRank);
  const cells = WHERE.map((w) =>
    `${ours[w] ?? 0} v ${room[w] ?? 0}`.padStart(9));

  console.log([label.padEnd(11), ...cells].join(""));
}

const firstOf = (where: string, place: (p: Player) => number | null | undefined) => {
  const its = men
    .filter((p) => p.position === where && place(p) != null)
    .sort((a, b) => place(a)! - place(b)!);

  return its[0];
};

console.log("\nfirst man at each position, ours then the room's pick");

for (const where of WHERE) {
  const ourFirst = firstOf(where, (p) => p.rank);
  const roomFirst = firstOf(where, (p) => p.adpRank);

  console.log(
    where.padEnd(5),
    `ours ${String(ourFirst?.rank ?? "-").padStart(4)} ${ourFirst?.name ?? ""}`
      .padEnd(34),
    `room ${String(roomFirst?.adpRank ?? "-").padStart(4)} ${roomFirst?.name ?? ""}`,
  );
}

const gaps = men
  .filter((p) => p.rank != null && p.adpRank != null)
  .map((p) => ({ p, gap: p.adpRank! - p.rank! }))
  .sort((a, b) => b.gap - a.gap);

console.log("\nwe are earliest on these, against the room");

for (const { p, gap } of gaps.slice(0, 15)) {
  console.log(
    `  ${p.position.padEnd(4)} ${p.name.padEnd(24)} ours ${String(p.rank).padStart(4)}  room ${String(p.adpRank).padStart(4)}  +${gap}`,
  );
}
