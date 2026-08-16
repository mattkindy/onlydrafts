// Who do I start: predictions with floor and ceiling for a coming
// week. Run: npx tsx scripts/start.ts --season 2025 --week 10 "st. brown" "nacua"

import { loadGames } from "../src/data/nflverse.js";
import { normalizeName } from "../src/data/names.js";
import {
  weeklyExamplesForSeason,
  weeklyProspectiveForWeek,
  weeklyRow,
} from "../src/features/weeklyModel.js";
import type { WeeklyExample } from "../src/features/weekly.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import {
  buildResidualModel,
  outcomeQuantile,
} from "../src/backtest/intervals.js";

function argOf(flag: string, fallback: number): number {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : Number(process.argv[index + 1]);
}

async function main(): Promise<void> {
  const season = argOf("--season", 2025);
  const week = argOf("--week", 10);
  const names = process.argv
    .slice(2)
    .filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--season" && all[i - 1] !== "--week")
    .map(normalizeName);

  const games = await loadGames();
  const train: WeeklyExample[] = [];

  for (let s = 2016; s < season; s++) {
    train.push(...(await weeklyExamplesForSeason(s, games)));
  }

  const weights = fitRidge(train.map(weeklyRow), train.map((e) => e.target), 25);
  const residuals = buildResidualModel(
    train.map((e) => ({
      position: e.position,
      predicted: predictRidge(weights, weeklyRow(e)),
      actual: e.target,
    })),
    5,
  );

  const slate = await weeklyProspectiveForWeek(season, week, games);
  const requested =
    names.length > 0
      ? slate.filter((e) =>
          names.some((n) => normalizeName(e.playerName).includes(n)),
        )
      : slate;

  const rows = requested
    .map((e) => {
      const predicted = predictRidge(weights, weeklyRow(e));
      return {
        e,
        predicted,
        floor: outcomeQuantile(residuals, e.position, predicted, 0.1),
        ceiling: outcomeQuantile(residuals, e.position, predicted, 0.9),
      };
    })
    .sort((a, b) => b.predicted - a.predicted);

  const shown = names.length > 0 ? rows : rows.slice(0, 25);

  console.log(`${season} week ${week}`);
  console.log(
    "player                      pos  proj  floor  ceil  vs    implied recent-ppg snaps",
  );

  for (const { e, predicted, floor, ceiling } of shown) {
    const venue = e.home ? "v" : "@";
    console.log(
      `${e.playerName.padEnd(27)} ${e.position.padEnd(3)} ${predicted.toFixed(1).padStart(5)} ${floor.toFixed(1).padStart(6)} ${ceiling.toFixed(1).padStart(5)}  ${venue}${e.opponent.padEnd(4)} ${e.impliedTotal.toFixed(1).padStart(6)} ${e.last4.toFixed(1).padStart(9)} ${(e.snapRecent * 100).toFixed(0).padStart(4)}%`,
    );
  }

  if (names.length > 1 && shown.length > 1) {
    console.log(
      `\nstart ${shown[0]!.e.playerName}. He projects ${(shown[0]!.predicted - shown[1]!.predicted).toFixed(1)} points ahead of ${shown[1]!.e.playerName}, with a similar range.`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
