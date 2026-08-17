/**
 * Within-season trajectory measured as no help on average, so the
 * model carries it and ignores it. This asks whether the average hides
 * a case: a man whose season falls off a cliff and who turns up on the
 * report with a soft tissue injury around the same time.
 *
 * Emeka Egbuka went 15.5 a game over five weeks and 2.9 over the
 * twelve after, with a hamstring listed in weeks seven and eight, and
 * the model projects him at what the whole season averaged.
 *
 * Run: npx tsx scripts/lingeringInjuryEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { loadPlayerStats, RAW_DIR } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { spearman, rmse } from "../src/backtest/metrics.js";

const SEASONS = [2021, 2022, 2023, 2024, 2025];
const SOFT = /hamstring|groin|quad|calf|hip|abdom|oblique|adductor/i;

interface Year {
  id: string; name: string; season: number; position: string;
  early: number; late: number; whole: number; games: number;
  softLate: boolean;
}

async function main(): Promise<void> {
  const years: Year[] = [];

  for (const season of SEASONS) {
    const listed = new Map<string, number[]>();

    for (const row of parseCsv(
      await readFile(join(RAW_DIR, `injuries_${season}.csv`), "utf8").catch(() => ""),
    )) {
      const what = `${row["report_primary_injury"] ?? ""} ${row["practice_primary_injury"] ?? ""}`;
      if (!SOFT.test(what)) continue;
      const id = row["gsis_id"] ?? "";
      listed.set(id, [...(listed.get(id) ?? []), Number(row["week"])]);
    }

    const byPlayer = new Map<string, { name: string; position: string; weeks: [number, number][] }>();

    for (const row of await loadPlayerStats(season)) {
      if (row.week > 18 || !["RB", "WR", "TE"].includes(row.position)) continue;
      const own = byPlayer.get(row.playerId) ??
        { name: row.playerName, position: row.position, weeks: [] as [number, number][] };
      own.weeks.push([row.week, fantasyPoints(row.statLine, presets.standard)]);
      byPlayer.set(row.playerId, own);
    }

    for (const [id, own] of byPlayer) {
      if (own.weeks.length < 12) continue;
      own.weeks.sort((a, b) => a[0] - b[0]);
      const cut = Math.floor(own.weeks.length / 3);
      const early = own.weeks.slice(0, cut);
      const late = own.weeks.slice(cut);
      const mean = (xs: [number, number][]) =>
        xs.reduce((a, b) => a + b[1], 0) / xs.length;
      // a soft tissue listing anywhere from the cut onward
      const after = (listed.get(id) ?? []).some((w) => w >= own.weeks[cut]![0] - 1);

      years.push({
        id, name: own.name, season, position: own.position,
        early: mean(early), late: mean(late), whole: mean(own.weeks),
        games: own.weeks.length, softLate: after,
      });
    }
  }

  const byKey = new Map(years.map((y) => [`${y.id}|${y.season}`, y]));
  const pairs: { before: Year; after: Year }[] = [];

  for (const year of years) {
    const before = byKey.get(`${year.id}|${year.season - 1}`);
    if (before) pairs.push({ before, after: year });
  }

  console.log(`${pairs.length} pairs\n`);

  const score = (label: string, sub: typeof pairs) => {
    if (sub.length < 25) {
      console.log("  " + label.padEnd(38) + "too few");
      return;
    }

    const truth = sub.map((p) => p.after.whole);
    const line = (name: string, get: (y: Year) => number) =>
      "    " + name.padEnd(26) +
      spearman(sub.map((p) => get(p.before)), truth).toFixed(3).padStart(8) +
      rmse(sub.map((p) => get(p.before)), truth).toFixed(2).padStart(8);

    console.log("\n  " + label + ", " + sub.length + " of them");
    console.log("    predictor                spearman    rmse");
    console.log(line("his whole season", (y) => y.whole));
    console.log(line("his first third", (y) => y.early));
    console.log(line("the rest of it", (y) => y.late));
    console.log(line("half and half", (y) => (y.early + y.late) / 2));
  };

  // a cliff is the last two thirds coming in well under the first
  const cliff = (y: Year) => y.early > 0 && y.late < y.early * 0.6;

  score("everyone", pairs);
  score("fell off a cliff, with a soft tissue listing",
    pairs.filter((p) => cliff(p.before) && p.before.softLate));
  score("fell off a cliff, nothing on the report",
    pairs.filter((p) => cliff(p.before) && !p.before.softLate));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
