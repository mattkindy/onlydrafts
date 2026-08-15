// Rolling evaluation of the rookie model: each class from 2019 on is
// predicted from earlier classes only, then compared to the market.
// Run: npx tsx scripts/rookieEval.ts

import { loadGames } from "../src/data/nflverse.js";
import { spearman } from "../src/backtest/metrics.js";
import { buildSeasonData } from "../src/features/seasonModel.js";
import {
  fitRookieModel,
  predictRookie,
  rookiesFor,
  type RookieExample,
} from "../src/features/rookies.js";
import { loadAdp } from "../src/data/adp.js";
import { normalizeName } from "../src/data/names.js";

const SEASONS = [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];

async function main(): Promise<void> {
  const data = await buildSeasonData(SEASONS);
  const games = await loadGames();
  const classes = new Map<number, RookieExample[]>();

  for (const season of SEASONS.slice(2)) {
    classes.set(season, await rookiesFor(season, data, games));
  }

  const modelScores: number[] = [];
  const pickScores: number[] = [];
  const adpScores: number[] = [];
  const pickOnAdpScores: number[] = [];

  for (const target of [2019, 2020, 2021, 2022, 2023, 2024, 2025]) {
    const train = [...classes.entries()]
      .filter(([season]) => season < target)
      .flatMap(([, list]) => list);
    const weights = fitRookieModel(train);
    const adp = await loadAdp(target);

    const test = classes
      .get(target)!
      .filter((r) => r.actualPpg !== undefined && r.actualGames >= 3);
    const actual = test.map((r) => r.actualPpg!);

    modelScores.push(
      spearman(test.map((r) => predictRookie(weights, r)), actual),
    );
    pickScores.push(spearman(test.map((r) => -r.overall), actual));

    const withAdp = test.filter((r) =>
      adp.has(`${normalizeName(r.name)}|${r.position}`),
    );
    adpScores.push(
      spearman(
        withAdp.map((r) => -adp.get(`${normalizeName(r.name)}|${r.position}`)!.adp),
        withAdp.map((r) => r.actualPpg!),
      ),
    );
    pickOnAdpScores.push(
      spearman(withAdp.map((r) => -r.overall), withAdp.map((r) => r.actualPpg!)),
    );

    console.log(
      `${target}: ${test.length} rookies with outcomes, ${withAdp.length} drafted in fantasy`,
    );
  }

  const mean = (list: number[]) =>
    list.reduce((s, x) => s + x, 0) / list.length;

  console.log(`\nrookie ranking, rolling means:`);
  console.log(`  draft pick alone   ${mean(pickScores).toFixed(3)}`);
  console.log(`  rookie model       ${mean(modelScores).toFixed(3)}`);
  console.log(
    `  market ADP         ${mean(adpScores).toFixed(3)} (fantasy-drafted rookies only)`,
  );
  console.log(
    `  draft pick, same subset ${mean(pickOnAdpScores).toFixed(3)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
