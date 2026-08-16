/**
 * The shadow-corner question again, with the population coming from
 * rules instead of from sorting inside a loop.
 *
 * Which receiver leads a room, which defence he met, and which weeks
 * count are all derived. This script only does the arithmetic the
 * rules cannot: subtract what a man usually scores from what he
 * scored that day.
 *
 * Run: npx tsx scripts/cornerFacts.ts
 */

import { loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { spearman } from "../src/backtest/metrics.js";
import { loadFacts, ROOM_RULES, LAST_COUNTING_WEEK } from "../src/datalog/facts.js";

const SEASONS = [2021, 2022, 2023, 2024, 2025];

async function main(): Promise<void> {
  console.time("facts");
  const { db } = await loadFacts(SEASONS, ROOM_RULES);
  console.timeEnd("facts");

  for (const name of ["roomLeader", "facedDefence", "leaderMet", "supportMet"]) {
    console.log("  " + name.padEnd(14) + db.facts(name).length);
  }

  // what each man scored, and what he usually scored
  const scored = new Map<string, number>();
  const usual = new Map<string, { total: number; games: number }>();

  for (const season of SEASONS) {
    for (const row of await loadPlayerStats(season)) {
      if (row.week > LAST_COUNTING_WEEK) continue;
      const points = fantasyPoints(row.statLine, presets.standard);
      scored.set(`${row.playerId}|${season}|${row.week}`, points);
      const own = usual.get(`${row.playerId}|${season}`) ?? { total: 0, games: 0 };
      own.total += points;
      own.games++;
      usual.set(`${row.playerId}|${season}`, own);
    }
  }

  const shortfall = (tuples: readonly (readonly (string | number)[])[]) => {
    const byDefence = new Map<string, number[]>();

    for (const [p, d, s, w] of tuples as [string, string, number, number][]) {
      const own = usual.get(`${p}|${s}`);
      const day = scored.get(`${p}|${s}|${w}`);
      if (!own || own.games < 8 || day === undefined) continue;
      const key = `${d}|${s}`;
      byDefence.set(key, [...(byDefence.get(key) ?? []), day - own.total / own.games]);
    }

    return byDefence;
  };

  const onLeaders = shortfall(db.facts("leaderMet"));
  const onSupport = shortfall(db.facts("supportMet"));
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  interface Row { defence: string; season: number; extra: number; general: number }
  const rows: Row[] = [];

  for (const [key, leaders] of onLeaders) {
    const support = onSupport.get(key);
    if (!support || leaders.length < 10 || support.length < 15) continue;
    const [defence, season] = key.split("|");
    rows.push({
      defence: defence!, season: Number(season),
      extra: mean(leaders) - mean(support),
      general: mean(support),
    });
  }

  const spread = [...rows.map((r) => r.extra)].sort((a, b) => a - b);
  console.log(`\n${rows.length} defence-seasons\n`);
  console.log("points taken off the opposing room leader, beyond what the");
  console.log("same defence took off the men behind him that day:\n");
  console.log("  toughest on the leader  " + spread[0]!.toFixed(2));
  console.log("  typical                 " + spread[Math.floor(spread.length / 2)]!.toFixed(2));
  console.log("  easiest                 " + spread.at(-1)!.toFixed(2));

  const byKey = new Map(rows.map((r) => [`${r.defence}|${r.season}`, r]));
  const pairs: [Row, Row][] = [];

  for (const row of rows) {
    const before = byKey.get(`${row.defence}|${row.season - 1}`);
    if (before) pairs.push([before, row]);
  }

  console.log(`\nyear over year, ${pairs.length} pairs:`);
  console.log("  suppression of everyone      " +
    spearman(pairs.map(([a]) => a.general), pairs.map(([, b]) => b.general)).toFixed(3));
  console.log("  extra on the room leader     " +
    spearman(pairs.map(([a]) => a.extra), pairs.map(([, b]) => b.extra)).toFixed(3));
  console.log("\nthe hand-written version put these at .100 and .204");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
