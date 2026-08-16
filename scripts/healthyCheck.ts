// What a player's healthy games looked like next to his full season.
// Run: npx tsx scripts/healthyCheck.ts <leagueId> <name> [name...]

import { buildSeasonData } from "../src/features/seasonModel.js";
import { setScoring } from "../src/scoring/active.js";
import { fetchLeagueScoring } from "../src/data/leagueScoring.js";

async function main(): Promise<void> {
  setScoring(await fetchLeagueScoring(process.argv[2]!));
  const names = process.argv.slice(3).map((n) => n.toLowerCase());
  const data = await buildSeasonData([2024, 2025]);
  const season = data.get(2025)!;

  for (const summary of season.summaries.values()) {
    if (!names.some((n) => summary.playerName.toLowerCase().includes(n))) {
      continue;
    }

    const healthy = season.healthyPpg.get(summary.playerId);
    const hurt = season.compromised.get(summary.playerId) ?? 0;
    console.log(
      summary.playerName.padEnd(22) +
        "season " + summary.pointsPerGame.toFixed(1).padStart(5) +
        "  healthy " + (healthy === undefined ? "  n/a" : healthy.toFixed(1).padStart(5)) +
        "  played hurt in " + (hurt * 100).toFixed(0) + "% of games",
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
