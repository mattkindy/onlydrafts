/**
 * Where Sleeper's own drafters are taking people.
 *
 * The public mocks we were reading come from a different site, and
 * the two rooms disagree by rounds: Bucky Irving goes at 47 in those
 * mocks and at 32 on Sleeper. The league drafts on Sleeper, so
 * Sleeper is the room to price against.
 *
 * Sleeper gives a number per scoring, and no range, so the spread
 * comes from the mocks we already have.
 *
 * Run: npx tsx scripts/pullSleeperAdp.ts 2026
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

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
  const url = "https://api.sleeper.app/projections/nfl/" + season +
    "?season_type=regular&order_by=adp" +
    WANTED.map((p) => `&position[]=${p}`).join("");
  const rows = await (await fetch(url)).json() as Row[];
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
  const at = join(
    import.meta.dirname, "..", "data", "raw", `adp_sleeper_${season}.json`,
  );
  await writeFile(at, JSON.stringify({ season, players: out }, null, 1));
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
