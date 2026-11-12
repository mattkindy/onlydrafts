/**
 * Whether the weekly line gains from how a player's role and his game
 * combine, which a straight sum of features cannot say.
 *
 * The ridge adds a side's implied total to every player alike: a back on
 * a quarter of his side's work and one on a twentieth get the same lift
 * from a twenty-eight point total. Scaling the touches by the total was
 * tried in the component model and double counted, since Vegas is already
 * in the ridge. This asks the other way round, letting the fit find how
 * much of the total a player's own role carries.
 *
 * Fitted on the seasons before each one scored, and scored on the same
 * players in every week from the fifth: A the ridge as shipped, R one
 * pooled ridge on the shipped features as the fair comparison for D, D the
 * pooled ridge with the interactions (his recent points, targets, carries
 * and snaps each times his side's implied total over the average, and his
 * recent points times the opponent), and G the shipped ridge with a small
 * boosted correction fitted to what it gets wrong, which can find any
 * such combination on its own. Pair accuracy within a position in a week,
 * mean absolute error and bias, on players the shipped line puts at five
 * or more.
 *
 * Run: npx tsx scripts/weeklyInteractionEval.ts
 */

import { loadGames } from "../src/data/nflverse.js";
import { fitGbm, predictGbm } from "../src/backtest/gbm.js";
import { addPairs, emptyTally, pairRate } from "../src/backtest/pairs.js";
import { fitRidge, predictRidge } from "../src/backtest/ridge.js";
import {
  fitWeeklyByPosition,
  predictWeeklyByPosition,
} from "../src/features/fitWeeklyByPosition.js";
import { weeklyExamplesForSeason, weeklyRow } from "../src/features/weeklyModel.js";
import type { WeeklyExample } from "../src/features/weekly.js";

const TRAIN_FROM = 2016;
const EVAL_SEASONS = [2024, 2025, 2026];
const POSITIONS = ["QB", "RB", "WR", "TE"];
const RELEVANT = 5;
const LAMBDA = 25;
/** what an average side is implied to score, which the ratio is taken over */
const AVERAGE_TOTAL = 22;

type Variant = "A shipped" | "R pooled ridge" | "D pooled + role x game" | "G shipped + boosted fix";
const VARIANTS: Variant[] = ["A shipped", "R pooled ridge", "D pooled + role x game", "G shipped + boosted fix"];

/** the shipped features, then how a player's role meets his game */
const interactionRow = (e: WeeklyExample) => {
  const game = e.impliedTotal / AVERAGE_TOTAL - 1;

  return [
    ...weeklyRow(e),
    e.last4 * game,
    e.targetsRecent * game,
    e.carriesRecent * game,
    e.snapRecent * game,
    e.last4 * e.oppIndex,
  ];
};

interface Scored { week: number; position: string; predicted: number; actual: number }

const games = await loadGames();
const rows = new Map<number, WeeklyExample[]>();

for (let s = TRAIN_FROM; s <= EVAL_SEASONS[EVAL_SEASONS.length - 1]!; s++) {
  rows.set(s, (await weeklyExamplesForSeason(s, games)).filter((e) => POSITIONS.includes(e.position)));
}

const pooled = new Map<Variant, Scored[]>(VARIANTS.map((v) => [v, []]));

for (const season of EVAL_SEASONS) {
  const past = Array.from({ length: season - TRAIN_FROM }, (_, i) => rows.get(TRAIN_FROM + i)!).flat();
  const shipped = fitWeeklyByPosition(past);
  const ridge = fitRidge(past.map(weeklyRow), past.map((e) => e.target), LAMBDA);
  const role = fitRidge(past.map(interactionRow), past.map((e) => e.target), LAMBDA);
  const fix = fitGbm(
    past.map(interactionRow),
    past.map((e) => e.target - predictWeeklyByPosition(shipped, e)),
    { trees: 120, depth: 3, rate: 0.05, minLeaf: 200 },
  );
  const scoredRows = rows.get(season)!.filter((e) => e.week >= 5 && predictWeeklyByPosition(shipped, e) >= RELEVANT);
  const bySeason = new Map<Variant, Scored[]>(VARIANTS.map((v) => [v, []]));
  const predict: Record<Variant, (e: WeeklyExample) => number> = {
    "A shipped": (e) => predictWeeklyByPosition(shipped, e),
    "R pooled ridge": (e) => predictRidge(ridge, weeklyRow(e)),
    "D pooled + role x game": (e) => predictRidge(role, interactionRow(e)),
    "G shipped + boosted fix": (e) => predictWeeklyByPosition(shipped, e) + predictGbm(fix, interactionRow(e)),
  };

  for (const variant of VARIANTS) {
    for (const e of scoredRows) {
      const row = { week: e.week, position: e.position, predicted: predict[variant](e), actual: e.target };

      bySeason.get(variant)!.push(row);
      pooled.get(variant)!.push(row);
    }
  }

  report(`${season}`, bySeason);
}

report("all seasons", pooled);

function report(title: string, scores: Map<Variant, Scored[]>) {
  console.log(`\n${title}: ${scores.get("A shipped")!.length} player weeks`);
  console.log("variant                     pairs    mae     bias");

  for (const variant of VARIANTS) {
    const at = scores.get(variant)!;
    const tally = emptyTally();
    const groups = new Map<string, Scored[]>();

    for (const r of at) {
      groups.set(`${r.week}|${r.position}`, [...(groups.get(`${r.week}|${r.position}`) ?? []), r]);
    }

    for (const g of groups.values()) {
      addPairs(tally, g.map((r) => ({ predicted: r.predicted, actual: r.actual })));
    }

    const mae = at.reduce((s, r) => s + Math.abs(r.predicted - r.actual), 0) / at.length;
    const bias = at.reduce((s, r) => s + r.predicted - r.actual, 0) / at.length;

    console.log(`${variant.padEnd(26)} ${(pairRate(tally, "all") * 100).toFixed(2).padStart(6)}%` +
      `  ${mae.toFixed(3)}  ${bias >= 0 ? "+" : ""}${bias.toFixed(3)}`);
  }
}
