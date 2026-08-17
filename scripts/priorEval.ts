/**
 * Shrinking a thin player toward himself instead of toward the league.
 *
 * fitRoles pulls anyone short of evidence toward a catch rate of .64,
 * 10.4 yards a catch and 4.3 a carry. Nobody is average across the
 * board, so the question is whether his attributes guess his rates
 * better than the league's numbers do, and by how much.
 *
 * Run: npx tsx scripts/priorEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { rmse, spearman } from "../src/backtest/metrics.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import {
  expectedFrom, fitWeights, blended, RATES,
  type Expected, type Shown,
} from "../src/features/attributePriors.js";
import { loadAfterContact } from "../src/data/advancedStats.js";

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

const noise = (n: number) => 1 / Math.sqrt(Math.max(2, n - 1));

interface Own {
  touches: number;
  carries: number;
  catches: number;
  targets: number;
  rushYards: number;
  recYards: number;
  long: number;
  gains: number[];
}

async function seasonOf(season: number): Promise<Map<string, Own>> {
  const rows = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
  )).filter((r) => Number(r["season"]) === season && r["player"]);
  const tally = new Map<string, Own>();

  for (const row of rows) {
    const own = tally.get(row["player"]!) ?? {
      touches: 0, carries: 0, catches: 0, targets: 0,
      rushYards: 0, recYards: 0, long: 0, gains: [],
    };
    const gained = Number(row["yards"]) || 0;
    own.touches++;
    own.gains.push(gained);
    if (gained >= 20) own.long++;

    if (row["playType"] === "run") {
      own.carries++;
      own.rushYards += gained;
    } else {
      own.targets++;
      if (gained > 0) { own.catches++; own.recYards += gained; }
    }

    tally.set(row["player"]!, own);
  }

  return tally;
}

const shownFrom = (
  tally: Map<string, Own>, deeper: Map<string, { afterContact: number }>,
): Shown[] =>
  [...tally].map(([playerId, own]) => {
    const mean = middle(own.gains);
    return {
      playerId, touches: own.touches,
      catchRate: own.targets > 0 ? own.catches / own.targets : 0.64,
      yardsPerCatch: own.catches > 0 ? own.recYards / own.catches : 10.4,
      // what he makes once he is hit, since a whole carry is the line
      afterContact: deeper.get(playerId)?.afterContact ?? 1.88,
      swing: mean > 0
        ? Math.sqrt(middle(own.gains.map((g) => (g - mean) ** 2))) / mean
        : 1.3,
    };
  });

async function main(): Promise<void> {
  const older = await seasonOf(2023);
  const before = await seasonOf(2024);
  const now = await seasonOf(2025);
  const deeper = {
    2023: await loadAfterContact(2023),
    2024: await loadAfterContact(2024),
    2025: await loadAfterContact(2025),
  };
  // what men described in 2023 went on to do in 2024, applied to how
  // men were described in 2024, to guess 2025
  const wentOnToDo = shownFrom(before, deeper[2024]).filter((m) => older.has(m.playerId));
  const priors = await expectedFrom(2023, wentOnToDo, 2024);
  const position = new Map<string, string>();

  for (const s of await loadPlayerStats(2025)) {
    position.set(s.playerId, s.position);
  }

  const league: Expected = {
    catchRate: 0.64, yardsPerCatch: 10.4, afterContact: 1.88, swing: 1.3,
  };
  const shownNow = new Map(shownFrom(now, deeper[2025]).map((m) => [m.playerId, m]));

  // how far to lean on the attributes for each, fitted on the season
  // before the one being scored so nothing chooses on its own answers
  const weights = fitWeights(priors, wentOnToDo, league);
  console.log(
    "how much of the attribute guess is used, fitted on the season before\n  " +
      RATES.map((r) => `${r} ${(100 * weights[r]).toFixed(0)}%`).join(", ") + "\n",
  );

  // the men the shrinking matters for: little behind them, enough after
  const thin = [...shownNow.values()].filter((m) =>
    m.touches >= 30 && (before.get(m.playerId)?.touches ?? 0) < 40 &&
    priors.has(m.playerId) && ["RB", "WR", "TE"].includes(position.get(m.playerId) ?? ""));

  console.log(
    `${thin.length} men with under forty touches before and thirty after\n`,
  );
  console.log("guessing what he did, for a man with little behind him");
  console.log("  the first three are how far off, in the rate's own units, so less is better");
  console.log("  the last is how well it orders the men, so more is better\n");
  console.log("  rate              league   attributes     mixed    order");

  for (const [label, of, low, high] of [
    ["catch rate", (m: Shown) => m.catchRate, 0.3, 0.95],
    ["yards a catch", (m: Shown) => m.yardsPerCatch, 3, 25],
    ["after contact", (m: Shown) => m.afterContact, 0.5, 5],
    ["how much he swings", (m: Shown) => m.swing, 0.1, 3],
  ] as [string, (m: Shown) => number, number, number][]) {
    const at = thin.filter((m) => priors.has(m.playerId)).filter((m) => {
      const value = of(m);
      return value > low && value < high;
    });

    if (at.length < 15) {
      continue;
    }

    const truth = at.map(of);
    const fromLeague = at.map(() => of(league as unknown as Shown));
    const fromAttributes = at.map((m) => of(priors.get(m.playerId)! as unknown as Shown));
    const mixed = at.map((m) =>
      of(blended(priors.get(m.playerId), league, weights) as unknown as Shown));
    console.log(
      "  " + label.padEnd(18) + rmse(fromLeague, truth).toFixed(3).padStart(6) +
      rmse(fromAttributes, truth).toFixed(3).padStart(14) +
      rmse(mixed, truth).toFixed(3).padStart(11) +
      spearman(fromAttributes, truth).toFixed(3).padStart(9),
    );
  }

  console.log(
    `\n  give or take ${noise(thin.length).toFixed(3)} on the ordering`,
  );

  // what the swing really is, since 0.35 looks like the wrong number
  // for anybody rather than the wrong number for a particular man
  const enough = [...shownNow.values()].filter((m) =>
    m.touches >= 50 && ["RB", "WR", "TE"].includes(position.get(m.playerId) ?? ""));
  const swings = enough.map((m) => m.swing).sort((a, b) => a - b);
  const q = (at: number) => swings[Math.floor(swings.length * at)]!;

  console.log(
    `\nhow far a man's yards really swing about his own average, ` +
      `${enough.length} men with fifty touches` +
      `\n  tenth ${q(0.1).toFixed(2)}   middle ${q(0.5).toFixed(2)}   ` +
      `ninetieth ${q(0.9).toFixed(2)}` +
      "\n  the model uses 0.35 for every one of them",
  );

  const byPosition = new Map<string, number[]>();

  for (const man of enough) {
    const spot = position.get(man.playerId)!;
    byPosition.set(spot, [...(byPosition.get(spot) ?? []), man.swing]);
  }

  for (const [spot, list] of byPosition) {
    console.log(`  ${spot}: ${middle(list).toFixed(2)} on ${list.length} men`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
