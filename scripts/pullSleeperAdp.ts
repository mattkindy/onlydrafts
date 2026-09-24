/**
 * Where Sleeper's own drafters are taking people, into the committed
 * ADP folder so the weekly build has it too. Run it before the season
 * starts; it will not replace a snapshot without --force, because
 * Sleeper's number keeps moving once the games begin.
 *
 * The mocks come from a different site, and the two rooms disagree by
 * rounds: Bucky Irving goes at 47 in those mocks and at 32 on Sleeper.
 * Sleeper gives a number per scoring and no range, so the spread comes
 * from the mocks.
 *
 * Run: npx tsx scripts/pullSleeperAdp.ts 2026 [--force]
 */

import { access } from "node:fs/promises";
import { join } from "node:path";
import { ADP_DIR, sleeperBoardFile } from "../src/data/adp.js";
import { fetchWithRetry } from "../src/data/fetchWithRetry.js";
import { writeAtomically } from "../src/data/writeAtomically.js";

const WANTED = ["QB", "RB", "WR", "TE", "K", "DEF"];

interface Row {
  player?: {
    first_name?: string;
    last_name?: string;
    position?: string;
    team?: string;
  };
  stats?: Record<string, number>;
}

async function pull(season: number): Promise<void> {
  const at = join(ADP_DIR, sleeperBoardFile(season));
  const already = await access(at).then(() => true, () => false);

  if (already && !process.argv.includes("--force")) {
    throw new Error(`${at} is already there; pass --force to replace it`);
  }

  const url = "https://api.sleeper.app/projections/nfl/" + season +
    "?season_type=regular&order_by=adp" +
    WANTED.map((p) => `&position[]=${p}`).join("");
  const rows = await (await fetchWithRetry(url, {
    label: `sleeper adp ${season}`,
  })).json() as Row[];
  const out: {
    name: string; position: string; team: string;
    standard: number; half: number; ppr: number;
  }[] = [];

  for (const row of rows) {
    const who = row.player;
    const stats = row.stats;

    if (!who?.first_name || !who.position || !stats) {
      continue;
    }

    const at = {
      standard: stats["adp_std"] ?? 999,
      half: stats["adp_half_ppr"] ?? 999,
      ppr: stats["adp_ppr"] ?? 999,
    };

    // 999 is Sleeper's way of saying nobody drafts him
    if (Math.min(at.standard, at.half, at.ppr) >= 999) {
      continue;
    }

    out.push({
      // a defence is drafted under the club's full name, and everything
      // else here goes by the code on its shirt
      name: who.position === "DEF"
        ? who.team ?? ""
        : `${who.first_name} ${who.last_name ?? ""}`.trim(),
      position: who.position,
      team: who.team ?? "",
      ...at,
    });
  }

  out.sort((a, b) => a.standard - b.standard);
  await writeAtomically(at, JSON.stringify({ season, players: out }, null, 1));
  console.log(`${out.length} players drafted on Sleeper, written to ${at}`);
  console.log(out.slice(0, 3)
    .map((p) => `  ${p.standard.toFixed(1).padStart(6)}  ${p.name}`).join("\n"));
}

async function main(): Promise<void> {
  const seasons = process.argv.slice(2).map(Number).filter(Boolean);

  for (const season of seasons.length ? seasons : [2026]) {
    await pull(season);
  }
}

await main();
