/**
 * What the win share says on the actual board, at two points in a draft.
 *
 * A kicker is the case to watch. With none on your roster the seat
 * scores nothing, so the first one is worth a lot; once you have one
 * the next is worth nothing. Points over replacement cannot say that.
 *
 * Run: npx tsx scripts/checkWinShare.ts
 */

import { readFileSync } from "node:fs";

import { rescore } from "../app/lib/board.ts";
import { baselineFor, typicalWeek, winShareFor } from "../app/lib/winShare.ts";
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
const opponent = typicalWeek(men, SLOTS, 12);
const bestAt = (where: string, skip = 0) =>
  men.filter((p) => p.position === where)[skip]!;

console.log(
  `a typical side scores ${(opponent.reduce((s, n) => s + n, 0) /
    opponent.length).toFixed(1)} a week\n`,
);

/** most of a lineup, with the kicker and the defence still to come */
const nearlyDone = [
  bestAt("QB"), bestAt("RB"), bestAt("RB", 1), bestAt("WR"),
  bestAt("WR", 1), bestAt("WR", 2), bestAt("TE"), bestAt("RB", 2),
  bestAt("WR", 3),
];

for (const [what, roster] of [
  ["nothing drafted yet", []],
  ["nine starters, no kicker", nearlyDone],
  ["and a kicker as well", [...nearlyDone, bestAt("K")]],
] as [string, Player[]][]) {
  const worth = winShareFor(baselineFor(roster, SLOTS), opponent);
  const ranked = men
    .map((p) => ({ p, its: worth(p) }))
    .sort((a, b) => b.its.added - a.its.added);

  console.log(`${what}\n`);

  for (const { p, its } of ranked.slice(0, 6)) {
    console.log(
      `  ${p.position.padEnd(4)} ${p.name.padEnd(22)}` +
      ` ${(its.added * 100).toFixed(1).padStart(5)}% of weeks` +
      `   starts ${(its.starts * 100).toFixed(0).padStart(3)}%`,
    );
  }

  const kickers = ranked.filter(({ p }) => p.position === "K");
  const best = kickers[0];

  console.log(
    `  best kicker: ${best?.p.name} at ` +
    `${((best?.its.added ?? 0) * 100).toFixed(1)}%\n`,
  );
}
