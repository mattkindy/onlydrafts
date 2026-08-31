/**
 * Who is on the commissioner's exempt list.
 *
 * A man goes on it while he is charged with something, and while he is
 * there he cannot practise or play. Nobody knows for how long, so he is
 * worth nothing to a fantasy team and the board should say so rather
 * than pricing him off last season.
 *
 * Run: npx tsx scripts/exemptCheck.ts [seasons, comma separated]
 */

import { exemptMen } from "../src/data/nflverse.js";

const SEASONS = (process.argv[2] ?? "2023,2024,2025,2026")
  .split(",").map(Number);

for (const season of SEASONS) {
  const men = await exemptMen(season);

  if (men.size === 0) {
    console.log(`${season}: nobody`);
    continue;
  }

  console.log(`${season}: ${men.size} men`);

  for (const [playerId, man] of men) {
    console.log(
      `  ${man.name.padEnd(22)} ${man.team.padEnd(4)} ` +
      `last seen week ${String(man.lastWeek).padStart(2)}  ${playerId}`,
    );
  }
}
