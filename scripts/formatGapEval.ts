/**
 * The market's draft order is PPR and this league is not, so anyone
 * whose value is in catches rather than yards is priced for a
 * different game.
 *
 * This finds who the room will overpay for and who it will let slide,
 * by projecting every player under both sets of rules.
 *
 * Run: npx tsx scripts/formatGapEval.ts
 */

import { loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { loadAdp } from "../src/data/adp.js";
import { normalizeName } from "../src/data/names.js";

const SEASON = 2025;

async function main(): Promise<void> {
  const adp = await loadAdp(2026);
  const played = new Map<string, {
    name: string; position: string; games: number;
    standard: number; ppr: number; catches: number;
  }>();

  for (const row of await loadPlayerStats(SEASON)) {
    if (row.week > 18 || !["RB", "WR", "TE"].includes(row.position)) {
      continue;
    }

    const own = played.get(row.playerId) ??
      { name: row.playerName, position: row.position, games: 0, standard: 0, ppr: 0, catches: 0 };
    own.games++;
    own.standard += fantasyPoints(row.statLine, presets.standard);
    own.ppr += fantasyPoints(row.statLine, presets.ppr);
    own.catches += row.statLine.receptions ?? 0;
    played.set(row.playerId, own);
  }

  interface Row {
    name: string; position: string; adp: number;
    standard: number; ppr: number; gap: number;
  }

  const rows: Row[] = [];

  for (const own of played.values()) {
    if (own.games < 10) continue;
    const market = adp.get(`${normalizeName(own.name)}|${own.position}`);
    if (!market || market.adp > 130) continue;
    const standard = own.standard / own.games;
    const ppr = own.ppr / own.games;
    rows.push({
      name: own.name, position: own.position, adp: market.adp,
      standard, ppr, gap: ppr - standard,
    });
  }

  // where each man would rank under each set of rules
  const byPpr = [...rows].sort((a, b) => b.ppr - a.ppr);
  const byStandard = [...rows].sort((a, b) => b.standard - a.standard);
  const pprRank = new Map(byPpr.map((r, i) => [r.name, i + 1]));
  const standardRank = new Map(byStandard.map((r, i) => [r.name, i + 1]));

  const moved = rows
    .map((r) => ({
      ...r,
      slips: standardRank.get(r.name)! - pprRank.get(r.name)!,
    }))
    .filter((r) => Math.abs(r.slips) >= 5);

  console.log(`${rows.length} players the market drafts inside 130\n`);
  console.log("who the room will overpay for, drafting on PPR in a league without it\n");
  console.log("  player               goes   ppr/g   std/g   slips");

  for (const r of [...moved].sort((a, b) => b.slips - a.slips).slice(0, 8)) {
    console.log(
      "  " + r.name.padEnd(21) + r.adp.toFixed(0).padStart(5) +
      r.ppr.toFixed(1).padStart(8) + r.standard.toFixed(1).padStart(8) +
      ("+" + r.slips).padStart(8),
    );
  }

  console.log("\nand who slides past them\n");
  console.log("  player               goes   ppr/g   std/g   rises");

  for (const r of [...moved].sort((a, b) => a.slips - b.slips).slice(0, 8)) {
    console.log(
      "  " + r.name.padEnd(21) + r.adp.toFixed(0).padStart(5) +
      r.ppr.toFixed(1).padStart(8) + r.standard.toFixed(1).padStart(8) +
      String(-r.slips).padStart(8),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
