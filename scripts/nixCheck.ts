// Why does the model like a given quarterback? Prints his scoring in
// this league's rules next to the position.
// Run: npx tsx scripts/nixCheck.ts <leagueId> <name fragment>

import { buildSeasonData } from "../src/features/seasonModel.js";
import { setScoring } from "../src/scoring/active.js";
import { fetchLeagueScoring } from "../src/data/leagueScoring.js";

async function main(): Promise<void> {
  setScoring(await fetchLeagueScoring(process.argv[2]!));
  const who = (process.argv[3] ?? "Nix").toLowerCase();
  const data = await buildSeasonData([2023, 2024, 2025]);

  for (const season of [2024, 2025]) {
    const summaries = data.get(season)!.summaries;
    const target = [...summaries.values()].find((s) =>
      s.playerName.toLowerCase().includes(who),
    );
    const qbs = [...summaries.values()]
      .filter((s) => s.position === "QB" && s.games >= 10)
      .sort((a, b) => b.pointsPerGame - a.pointsPerGame);

    if (!target) {
      console.log(season + ": not found");
      continue;
    }

    const rank = qbs.findIndex((q) => q.playerId === target.playerId) + 1;
    console.log(
      season + ": " + target.playerName + " " + target.pointsPerGame.toFixed(1) +
        " a game, QB" + rank + " of " + qbs.length + ", " + target.games + " games, " +
        (target.tdPointShare * 100).toFixed(0) + "% of points from touchdowns, " +
        target.carriesPerGame.toFixed(1) + " carries a game",
    );
    console.log(
      "   top five: " +
        qbs.slice(0, 5).map((q) => q.playerName.split(" ").slice(-1)[0] + " " + q.pointsPerGame.toFixed(1)).join(", "),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
