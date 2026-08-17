/**
 * What the contract file covers, before anything is built on it.
 *
 * Run: npx tsx scripts/contractCheck.ts
 */

import { loadContracts, dealFor } from "../src/data/contracts.js";
import { loadPlayerStats } from "../src/data/nflverse.js";

async function main(): Promise<void> {
  const contracts = await loadContracts();
  console.log(`${contracts.size} players with a deal on file`);

  const every = [...contracts.values()].flat();
  const years = every.map((d) => d.yearSigned).sort((a, b) => a - b);
  console.log(
    `deals run from ${years[0]} to ${years[years.length - 1]}, ` +
      `${every.filter((d) => d.yearSigned >= 2023).length} signed since 2023`,
  );
  const positions = new Map<string, number>();
  for (const deal of every) {
    positions.set(deal.position, (positions.get(deal.position) ?? 0) + 1);
  }
  console.log("positions:", [...positions].sort((a, b) => b[1] - a[1])
    .slice(0, 12).map(([p, n]) => `${p} ${n}`).join(", "));

  const skill = every
    .filter((deal) => ["RB", "WR", "TE"].includes(deal.position) && deal.yearSigned >= 2023)
    .sort((a, b) => b.capShare - a.capShare);
  console.log(`${skill.length} skill deals signed since 2023, the biggest:`);

  for (const deal of skill.slice(0, 5)) {
    console.log(
      `  ${deal.name.padEnd(22)} ${deal.position} ${deal.team.padEnd(14)} ` +
        `${(100 * deal.capShare).toFixed(2)}% of the cap, ${deal.years} years`,
    );
  }

  // how many of the men we score actually match
  const seen = new Map<string, string>();

  for (const s of await loadPlayerStats(2025)) {
    if (s.week > 18 || !["RB", "WR", "TE"].includes(s.position)) continue;
    seen.set(s.playerName, s.position);
  }

  let found = 0;

  for (const [name, position] of seen) {
    if (dealFor(contracts, name, position, 2025)) found++;
  }

  console.log(
    `\n${found} of ${seen.size} men who played in 2025 have a deal we can find ` +
      `(${(100 * found / seen.size).toFixed(0)}%)`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
