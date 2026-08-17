/**
 * The case a description should win and an identity cannot enter.
 *
 * A rookie has never taken a snap, so anything that learns a number
 * per player has nothing for him. A description exists on draft day:
 * his height, his weight, where he went, what he ran. This asks
 * whether that predicts what he goes on to do.
 *
 * Run: npx tsx scripts/coldStartEval.ts
 */

import { loadPlayerStats, loadWeeklyRosters } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { rmse, spearman } from "../src/backtest/metrics.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import { buildPlayerVectors, ATTRIBUTES } from "../src/features/playerVector.js";

const SEASONS = [2021, 2022, 2023, 2024, 2025];
const RULES = presets.standard;

/** the parts of a description a rookie has before he plays */
const KNOWN_BEFORE = new Set([
  "height", "weight", "age", "experience", "draftPick", "wentUndrafted",
  "speed", "explosion", "agility", "power", "burst",
]);

async function main(): Promise<void> {
  interface Rookie {
    season: number; name: string; position: string;
    before: number[]; scored: number;
  }

  const rookies: Rookie[] = [];

  for (const season of SEASONS) {
    const described = await buildPlayerVectors(season);
    const firstYear = new Set<string>();

    for (const row of await loadWeeklyRosters(season)) {
      // his first season on a roster, so nothing about him is learnable
      if (row.draftYear === season || (row.yearsExperience ?? 99) === 0) {
        firstYear.add(row.playerId);
      }
    }

    const played = new Map<string, { name: string; position: string; points: number; games: number }>();

    for (const row of await loadPlayerStats(season)) {
      if (row.week > 18 || !firstYear.has(row.playerId)) continue;
      if (!["RB", "WR", "TE"].includes(row.position)) continue;
      const own = played.get(row.playerId) ??
        { name: row.playerName, position: row.position, points: 0, games: 0 };
      own.points += fantasyPoints(row.statLine, RULES);
      own.games++;
      played.set(row.playerId, own);
    }

    for (const [id, own] of played) {
      const description = described.get(id);
      if (!description || own.games < 6) continue;
      rookies.push({
        season, name: own.name, position: own.position,
        before: ATTRIBUTES
          .map((attribute, i) => (KNOWN_BEFORE.has(attribute) ? description.values[i]! : 0))
          .filter((_, i) => KNOWN_BEFORE.has(ATTRIBUTES[i]!)),
        scored: own.points / own.games,
      });
    }
  }

  const train = rookies.filter((r) => r.season < 2025);
  const test = rookies.filter((r) => r.season === 2025);
  console.log(`${train.length} rookies to learn from, ${test.length} to score on\n`);

  const row = (r: Rookie) => [
    1, ...r.before,
    r.position === "RB" ? 1 : 0, r.position === "TE" ? 1 : 0,
  ];
  const weights = fitRidge(train.map(row), train.map((r) => r.scored), 2);
  const actual = test.map((r) => r.scored);
  const average = train.reduce((a, r) => a + r.scored, 0) / train.length;

  console.log("predicting what a rookie averages in his first season\n");
  console.log("  from                        rmse   spearman");
  console.log("  the average rookie" +
    rmse(test.map(() => average), actual).toFixed(3).padStart(12) + "      0.000");
  console.log("  where he was drafted alone" +
    rmse(
      test.map((r) => predictRidge(
        fitRidge(
          train.map((t) => [1, t.before[ATTRIBUTES.filter((a) => KNOWN_BEFORE.has(a))
            .indexOf("draftPick")]!]),
          train.map((t) => t.scored), 2,
        ),
        [1, r.before[ATTRIBUTES.filter((a) => KNOWN_BEFORE.has(a)).indexOf("draftPick")]!],
      )),
      actual,
    ).toFixed(3).padStart(4) +
    spearman(
      test.map((r) => -r.before[ATTRIBUTES.filter((a) => KNOWN_BEFORE.has(a))
        .indexOf("draftPick")]!),
      actual,
    ).toFixed(3).padStart(11));
  console.log("  his whole description" +
    rmse(test.map((r) => predictRidge(weights, row(r))), actual).toFixed(3).padStart(9) +
    spearman(test.map((r) => predictRidge(weights, row(r))), actual).toFixed(3).padStart(11));

  const called = test
    .map((r) => ({ name: r.name, said: predictRidge(weights, row(r)), did: r.scored }))
    .sort((a, b) => b.said - a.said);

  console.log("\n  the five it liked most, and what they did\n");

  for (const one of called.slice(0, 5)) {
    console.log("    " + one.name.padEnd(22) +
      "expected " + one.said.toFixed(1) + ", scored " + one.did.toFixed(1));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
