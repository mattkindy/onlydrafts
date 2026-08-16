// Builds the static weekly site into docs/: the page plus prediction
// JSON for the requested weeks, ready for GitHub Pages.
// Run: npx tsx scripts/buildSite.ts --season 2025 --weeks 10-12

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadGames } from "../src/data/nflverse.js";
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
import { normalizeName } from "../src/data/names.js";

const DOCS = join(import.meta.dirname, "..", "docs", "weekly");

function argOf(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1]!;
}

async function main(): Promise<void> {
  const season = Number(argOf("--season", "2025"));
  const weeksArg = argOf("--weeks", "10-12");
  const range = weeksArg.match(/^(\d+)-(\d+)$/);
  const weeks = range
    ? Array.from(
        { length: Number(range[2]) - Number(range[1]) + 1 },
        (_, i) => Number(range[1]) + i,
      )
    : weeksArg.split(",").map(Number);

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

  await mkdir(join(DOCS, "data"), { recursive: true });

  const index: { season: number; week: number }[] = [];

  for (const week of weeks) {
    const rows = (await weeklyProspectiveForWeek(season, week, games))
      .map((e) => {
        const predicted = predictRidge(weights, weeklyRow(e));
        return {
          name: e.playerName,
          key: normalizeName(e.playerName),
          position: e.position,
          team: e.teamId,
          opponent: (e.home ? "v " : "@ ") + e.opponent,
          predicted: Number(predicted.toFixed(1)),
          floor: Number(
            outcomeQuantile(residuals, e.position, predicted, 0.1).toFixed(1),
          ),
          ceiling: Number(
            outcomeQuantile(residuals, e.position, predicted, 0.9).toFixed(1),
          ),
          snaps: Math.round(e.snapRecent * 100),
        };
      })
      .sort((a, b) => b.predicted - a.predicted);

    await writeFile(
      join(DOCS, "data", `slate-${season}-${week}.json`),
      JSON.stringify({ season, week, players: rows }),
    );
    index.push({ season, week });
    console.log(`week ${week}: ${rows.length} players`);
  }

  await writeFile(join(DOCS, "data", "index.json"), JSON.stringify(index));
  await writeFile(
    join(DOCS, "index.html"),
    await readFile(join(import.meta.dirname, "..", "tools", "ui", "index.html"), "utf8"),
  );
  console.log(`site written to ${DOCS}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
