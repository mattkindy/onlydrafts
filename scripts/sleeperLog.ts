/**
 * The named picks behind the sleeper bench, so a person can see who the
 * model caught, who it missed, and how its worst calls went wrong.
 *
 * At each cut it prints three tables over the cheap candidates: the
 * model's top fifteen, the fifteen biggest breakouts it ranked outside
 * its top fifty, and the picks in its top fifteen that finished
 * furthest below the starter tier. Every row shows what the player had
 * done by the cut, what the model claimed, and what he did after.
 *
 * Run: npx tsx scripts/sleeperLog.ts [season] [week]
 */

import {
  build, cheap, CUTS, SEASONS, type Row,
} from "../src/backtest/sleeperBench.js";
import {
  benchExamples, benchFits, benchingBy, buildBenching, fillBenchingTerms,
} from "../src/backtest/expectedBench.js";
import { benchChance } from "../src/model/expectedSleepers.js";
import {
  fitSleepersAsOf, rankSleepers,
  type SleeperExample, type SleeperScore,
} from "../src/model/sleepers.js";

/** how deep each table goes, and past what rank a breakout counts as missed */
const TOP = 15;
const MISSED_PAST = 50;
const WORST = 5;

/* ---------- printing ---------- */

const signed = (value: number, digits: number) =>
  `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;

const HEADER =
  " rk  player                  pos tm   price      share   ppg gp" +
  "    edge  proj   rest-ppg   pts   gms  tier     by";

function line(row: Row, score: SleeperScore | undefined, rank: number): string {
  const cut = row.cut;
  const price = cut.drafted ? `pick ${cut.price.toFixed(0)}` : "undrafted";

  return [
    String(rank).padStart(3),
    ` ${cut.playerName.slice(0, 22).padEnd(22)}`,
    ` ${cut.position.padEnd(3)}`,
    `${(row.club || "?").padEnd(4)}`,
    `${price.padEnd(9)}`,
    `${(cut.rawWorkShare * 100).toFixed(0).padStart(5)}%`,
    `${cut.ppgSoFar.toFixed(1).padStart(6)}`,
    `${String(cut.gamesPlayed).padStart(3)}`,
    `${score === undefined ? "" : signed(score.score, 1).padStart(8)}`,
    `${score === undefined ? "" : score.modelPpg.toFixed(1).padStart(6)}`,
    `${row.restOfSeasonPpg.toFixed(1).padStart(10)}`,
    `${row.restOfSeasonTotal.toFixed(0).padStart(6)}`,
    ` ${String(row.gamesAfter).padStart(2)}/${String(row.weeksLeft)
      .padEnd(2)}`,
    ` ${row.hit ? "yes" : "no "}`,
    `${signed(row.tierMargin, 0).padStart(6)}`,
  ].join("");
}

function table(
  title: string,
  rows: { row: Row; rank: number }[],
  scored: Map<string, SleeperScore>,
): void {
  console.log(`\n${title}`);
  console.log(HEADER);

  if (rows.length === 0) {
    console.log("  none");

    return;
  }

  for (const { row, rank } of rows) {
    console.log(line(row, scored.get(row.cut.playerId), rank));
  }
}

/* ---------- one cut ---------- */

function reportCut(
  season: number, week: number, population: Row[],
  ranked: SleeperScore[],
): void {
  const scored = new Map(ranked.map((one) => [one.playerId, one]));
  const rankOf = new Map(ranked.map((one, i) => [one.playerId, i + 1]));
  const at = (row: Row) => ({ row, rank: rankOf.get(row.cut.playerId) ?? 0 });
  const byRank = [...population]
    .sort((a, b) => (rankOf.get(a.cut.playerId) ?? Infinity)
      - (rankOf.get(b.cut.playerId) ?? Infinity));
  const top = byRank.slice(0, TOP);

  console.log(
    `\n==== ${season}, after week ${week}: ${population.length} candidates ` +
    "priced past 100 or undrafted ====",
  );
  table(`the model's top ${TOP}`, top.map(at), scored);

  const missed = population
    .filter((row) => row.hit && (rankOf.get(row.cut.playerId) ?? 0)
      > MISSED_PAST)
    .sort((a, b) => b.restOfSeasonPpg - a.restOfSeasonPpg)
    .slice(0, TOP);
  table(
    `breakouts the model ranked outside its top ${MISSED_PAST}`,
    missed.map(at), scored,
  );

  const worst = top
    .filter((row) => row.tierMargin < 0)
    .sort((a, b) => a.tierMargin - b.tierMargin)
    .slice(0, WORST);
  table(
    `worst calls in the top ${TOP}, furthest below the tier first`,
    worst.map(at), scored,
  );
}

/* ---------- main ---------- */

async function main(): Promise<void> {
  const [seasonArg, weekArg] = process.argv.slice(2).map(Number);
  const { rows, priced, skipped } = await build(SEASONS);
  const cases = await buildBenching(priced, CUTS);
  const fitFor = benchFits(priced, benchExamples(cases));
  fillBenchingTerms(rows, benchingBy(cases), (season, cut) => {
    const fit = fitFor(season);

    return fit === undefined ? 0 : benchChance(fit, cut);
  });
  const examples: SleeperExample[] = rows.map((row) => ({
    cut: row.cut, restOfSeasonPpg: row.restOfSeasonPpg,
  }));
  const scorable = priced
    .filter((season) => season > (priced[0] ?? Infinity))
    .filter((season) => !Number.isFinite(seasonArg) || season === seasonArg);
  const weeks = CUTS
    .filter((week) => !Number.isFinite(weekArg) || week === weekArg);

  if (scorable.length === 0 || weeks.length === 0) {
    console.log(
      `nothing to print: the seasons with a fit are ${priced.slice(1)
        .join(", ")} and the cuts are weeks ${CUTS.join(", ")}`,
    );

    for (const [season, why] of skipped) {
      console.log(`  ${season} is out: ${why}`);
    }

    return;
  }

  console.log(
    "share and ppg are through the cut; edge is the model's claim in " +
    "points a game against his price, proj its rest-of-season line; " +
    "rest-ppg divides by the club's remaining weeks; by is points above " +
    "or below the last starter at his position.",
  );

  for (const season of scorable) {
    const fit = fitSleepersAsOf(season, examples);

    for (const week of weeks) {
      const population = rows.filter((row) =>
        row.cut.season === season && row.cut.week === week && cheap(row));
      const ranked = rankSleepers(fit, population.map((row) => row.cut));
      reportCut(season, week, population, ranked);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
