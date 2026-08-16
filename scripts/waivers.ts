// Waiver help: your roster ranked by this week's predictions, and the
// best players outside it at each position.
// Run: npx tsx scripts/waivers.ts --season 2025 --week 10 "nacua" "gibbs" ...

import { loadGames } from "../src/data/nflverse.js";
import { normalizeName } from "../src/data/names.js";
import {
  weeklyExamplesForSeason,
  weeklyProspectiveForWeek,
  weeklyRow,
} from "../src/features/weeklyModel.js";
import type { WeeklyExample } from "../src/features/weekly.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";

const POSITIONS = ["QB", "RB", "WR", "TE"];

function argOf(flag: string, fallback: number): number {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : Number(process.argv[index + 1]);
}

async function main(): Promise<void> {
  const season = argOf("--season", 2025);
  const week = argOf("--week", 10);
  const names = process.argv
    .slice(2)
    .filter(
      (a, i, all) =>
        !a.startsWith("--") &&
        all[i - 1] !== "--season" &&
        all[i - 1] !== "--week",
    )
    .map(normalizeName);

  if (names.length === 0) {
    console.log("give me your roster as player names");
    return;
  }

  const games = await loadGames();
  const train: WeeklyExample[] = [];

  for (let s = 2016; s < season; s++) {
    train.push(...(await weeklyExamplesForSeason(s, games)));
  }

  const weights = fitRidge(train.map(weeklyRow), train.map((e) => e.target), 25);
  const slate = await weeklyProspectiveForWeek(season, week, games);

  const mine = (e: WeeklyExample) =>
    names.some((n) => normalizeName(e.playerName).includes(n));
  const predicted = slate
    .map((e) => ({ e, points: predictRidge(weights, weeklyRow(e)) }))
    .sort((a, b) => b.points - a.points);

  console.log(`${season} week ${week}\n`);

  for (const position of POSITIONS) {
    const rostered = predicted.filter(
      (r) => r.e.position === position && mine(r.e),
    );
    const outside = predicted
      .filter((r) => r.e.position === position && !mine(r.e))
      .slice(0, 5);
    const worst = rostered[rostered.length - 1];

    console.log(`${position}:`);

    for (const r of rostered) {
      console.log(
        `  yours  ${r.e.playerName.padEnd(25)} ${r.points.toFixed(1)}`,
      );
    }

    for (const r of outside) {
      const flag =
        worst && r.points > worst.points + 2
          ? `  <- beats ${worst.e.playerName} by ${(r.points - worst.points).toFixed(1)}`
          : "";
      console.log(
        `  avail  ${r.e.playerName.padEnd(25)} ${r.points.toFixed(1)}${flag}`,
      );
    }

    console.log("");
  }

  console.log(
    "avail lists the best players outside your roster; check who is on waivers in your league",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
