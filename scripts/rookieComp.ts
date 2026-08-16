// Which rookie triggered the competition flag for a team and position.
// Run: npx tsx scripts/rookieComp.ts 2026 TB WR

import { loadWeeklyRosters } from "../src/data/nflverse.js";
import { mapPosition } from "../src/graph/build.js";

async function main(): Promise<void> {
  const season = Number(process.argv[2] ?? 2026);
  const team = process.argv[3] ?? "TB";
  const position = process.argv[4] ?? "WR";
  const roster = await loadWeeklyRosters(season);
  const seen = new Map<string, { name: string; entry?: number; pick?: number }>();

  for (const a of roster) {
    if (a.teamId !== team || mapPosition(a.rawPosition) !== position) {
      continue;
    }

    if (!seen.has(a.playerId)) {
      seen.set(a.playerId, { name: a.name, entry: a.draftYear, pick: a.draftOverall });
    }
  }

  console.log(team + " " + position + "s on the " + season + " roster:");

  for (const p of [...seen.values()].sort((a, b) => (a.pick ?? 999) - (b.pick ?? 999))) {
    const rookie = p.entry === season ? "  <- rookie" : "";
    console.log(
      "  " + p.name.padEnd(22) + "entered " + (p.entry ?? "?") +
        ", pick " + (p.pick ?? "undrafted") + rookie,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
