/**
 * Does a sleeper score beat the naive ways of finding a cheap player who
 * is about to be worth much more than he cost?
 *
 * At weeks 4, 6 and 8 of each season, over the players priced past 100 or
 * not drafted at all, every method picks its top twenty and is scored on
 * what those players went on to average and on how many of them finished
 * inside the tier a league starts. The rivals are the board's own order,
 * points a game so far, raw work share, and the model, with an oracle
 * that knew the rest of the season as the ceiling.
 *
 * Run: npx tsx scripts/sleeperEval.ts [--seasons 2016-2025]
 */

import {
  build, cheap, CUTS, SEASONS, TOP_PRICED, type Row,
} from "../src/backtest/sleeperBench.js";
import { seasonsAsked } from "../src/data/seasons.js";
import {
  fitSleepersAsOf, rankSleepers, SLEEPER_TERMS,
  type SleeperExample, type SleeperFit, type SleeperScore,
} from "../src/model/sleepers.js";

/** how deep each method picks, and where precision is read */
const PICKS = 20;
const AT = [10, 20];

/* ---------- the methods, and what each one is scored on ---------- */

/** what one method ranks by, biggest first */
type Order = (row: Row, scored: Map<string, SleeperScore>) => number;

const METHODS: Record<string, Order> = {
  "the price itself": (row) => -row.cut.price,
  "points a game so far": (row) => row.cut.ppgSoFar,
  "raw work share": (row) => row.cut.rawWorkShare,
  "the model": (row, scored) =>
    scored.get(row.cut.playerId)?.score ?? -Infinity,
  // Two ways of taking the price off the same fit, since the module's own
  // score is one reading of "what his price says" and the curve's median
  // at that price is the other.
  "the model over the curve": (row, scored) => {
    const his = scored.get(row.cut.playerId);

    return his === undefined ? -Infinity : his.modelPpg - his.priceMedian;
  },
  "the model's own line": (row, scored) =>
    scored.get(row.cut.playerId)?.modelPpg ?? -Infinity,
  "oracle: the rest known": (row) => row.restOfSeasonPpg,
};

const NAMES = Object.keys(METHODS);

function topPicks(
  rows: Row[], order: Order, scored: Map<string, SleeperScore>,
): Row[] {
  return [...rows]
    .sort((a, b) => {
      const gap = order(b, scored) - order(a, scored);

      return gap === 0 ? a.cut.playerId.localeCompare(b.cut.playerId) : gap;
    })
    .slice(0, PICKS);
}

/** what one method's picks were worth */
interface Tally {
  picks: number;
  points: number;
  hits: Record<number, number>;
  of: Record<number, number>;
}

const emptyTally = (): Tally => ({
  picks: 0, points: 0,
  hits: Object.fromEntries(AT.map((deep) => [deep, 0])),
  of: Object.fromEntries(AT.map((deep) => [deep, 0])),
});

function tallied(into: Tally, picks: Row[]): void {
  into.picks += picks.length;
  into.points += picks.reduce((sum, row) => sum + row.restOfSeasonPpg, 0);

  for (const deep of AT) {
    const top = picks.slice(0, deep);
    into.hits[deep] = (into.hits[deep] ?? 0) + top.filter((r) => r.hit).length;
    into.of[deep] = (into.of[deep] ?? 0) + top.length;
  }
}

const perPick = (tally: Tally) =>
  tally.picks === 0 ? 0 : tally.points / tally.picks;

const precision = (tally: Tally, deep: number) =>
  (tally.of[deep] ?? 0) === 0 ? 0 : (tally.hits[deep] ?? 0) / tally.of[deep]!;

/* ---------- printing ---------- */

const middleOf = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
};

function reportPooled(
  pooled: Map<string, Tally>, bySeason: Map<string, Map<number, Tally>>,
): void {
  console.log(
    "\nmethod                    ppg a pick   prec@10   prec@20   picks" +
    "   worst season  median   best",
  );

  for (const name of NAMES) {
    const tally = pooled.get(name)!;
    const seasons = [...(bySeason.get(name) ?? new Map()).values()]
      .map(perPick);
    console.log(
      `${name.padEnd(25)} ${perPick(tally).toFixed(2).padStart(6)}` +
      `   ${precision(tally, 10).toFixed(3).padStart(7)}` +
      `   ${precision(tally, 20).toFixed(3).padStart(7)}` +
      `   ${String(tally.picks).padStart(5)}` +
      `   ${Math.min(...seasons).toFixed(2).padStart(12)}` +
      `  ${middleOf(seasons).toFixed(2).padStart(6)}` +
      `  ${Math.max(...seasons).toFixed(2).padStart(5)}`,
    );
  }
}

/**
 * How many seasons each method beat each other one. A pooled gain of half
 * a point could be one season carrying the rest, and a row that reads
 * three of seven says so.
 */
function reportHeadToHead(
  bySeason: Map<string, Map<number, Tally>>,
  measure: string,
  read: (tally: Tally) => number,
): void {
  const seasons = [...(bySeason.get(NAMES[0]!) ?? new Map()).keys()].sort();
  console.log(`\nseasons won on ${measure}, out of ${seasons.length}`);
  console.log(
    `${"".padEnd(25)}${NAMES.map((n) => n.slice(0, 8).padStart(9)).join("")}`,
  );

  for (const name of NAMES) {
    const mine = bySeason.get(name)!;
    const cells = NAMES.map((other) => {
      if (other === name) {
        return "-".padStart(9);
      }

      const theirs = bySeason.get(other)!;
      const won = seasons.filter((season) =>
        read(mine.get(season)!) > read(theirs.get(season)!)).length;

      return String(won).padStart(9);
    });
    console.log(`${name.padEnd(25)}${cells.join("")}`);
  }
}

/**
 * What the last fit weighs each term at, in points a game per standard
 * deviation, so the terms can be read against each other.
 */
function reportWeights(fit: SleeperFit): void {
  console.log(
    `\nwhat the ${fit.trainedOn[0]} to ` +
    `${fit.trainedOn[fit.trainedOn.length - 1]} fit weighs, in points a ` +
    "game per deviation",
  );
  console.log(`  intercept${" ".repeat(15)}${fit.weights[0]!.toFixed(2)}`);

  for (let i = 0; i < SLEEPER_TERMS.length; i++) {
    console.log(
      `  ${SLEEPER_TERMS[i]!.padEnd(24)}${fit.weights[i + 1]!.toFixed(2)}`,
    );
  }
}

/** the reasons behind one cut's top few, since a bare ranking is no use */
function reportReasons(
  season: number, week: number, picks: SleeperScore[],
): void {
  console.log(`\nwhat the model said in ${season} after week ${week}`);

  for (const pick of picks) {
    const price = pick.drafted ? `pick ${pick.price.toFixed(0)}` : "undrafted";
    const said = (value: number) =>
      `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
    console.log(
      `  ${pick.playerName} (${pick.position}, ${price}) ${said(pick.score)} ` +
      `a game over the ${pick.pricePpg.toFixed(2)} his price says, and ` +
      `${pick.modelPpg.toFixed(2)} from here`,
    );
    console.log(
      `      ${pick.reasons.slice(0, 3)
        .map((one) => `${one.term} ${said(one.points)}`).join(", ")}`,
    );
  }
}

async function main(): Promise<void> {
  const seasons = seasonsAsked(process.argv, SEASONS);
  const { rows, priced, skipped } = await build(seasons);
  const examples: SleeperExample[] = rows.map((row) => ({
    cut: row.cut, restOfSeasonPpg: row.restOfSeasonPpg,
  }));
  const pooled = new Map(NAMES.map((name) => [name, emptyTally()]));
  const bySeason = new Map(
    NAMES.map((name) => [name, new Map<number, Tally>()]),
  );
  const scorable = priced.filter((season) => season > (priced[0] ?? Infinity));
  let last: { season: number; week: number; picks: SleeperScore[] } | undefined;

  if (scorable.length === 0) {
    console.log(
      "nothing to score: no season asked for has both a price curve and an " +
      "earlier season of cuts to fit on",
    );

    for (const [season, why] of skipped) {
      console.log(`  ${season} is out: ${why}`);
    }

    return;
  }

  for (const season of scorable) {
    const fit = fitSleepersAsOf(season, examples);

    for (const week of CUTS) {
      const population = rows.filter((row) =>
        row.cut.season === season && row.cut.week === week && cheap(row));
      const ranked = rankSleepers(fit, population.map((row) => row.cut));
      const scored = new Map(ranked.map((one) => [one.playerId, one]));

      for (const name of NAMES) {
        const picks = topPicks(population, METHODS[name]!, scored);
        tallied(pooled.get(name)!, picks);
        const seasons = bySeason.get(name)!;
        const tally = seasons.get(season) ?? emptyTally();
        tallied(tally, picks);
        seasons.set(season, tally);
      }

      last = { season, week, picks: ranked.slice(0, 5) };
    }
  }

  const fitted = fitSleepersAsOf(scorable[scorable.length - 1]!, examples);
  console.log(
    `weeks ${CUTS.join(", ")} of ${scorable[0]} to ` +
    `${scorable[scorable.length - 1]}, over the players priced past ` +
    `${TOP_PRICED} or undrafted, in PPR. Each method picks ${PICKS}.`,
  );
  console.log(
    `${rows.length} player cuts over ${priced.length} seasons, ` +
    `${rows.filter(cheap).length} of them cheap enough to be picked from. ` +
    `The last fit read ${fitted.examples} rows over ` +
    `${fitted.trainedOn.length} seasons.`,
  );

  for (const [season, why] of skipped) {
    console.log(`  ${season} is out: ${why}`);
  }

  if (priced.length > 0 && scorable.length < priced.length) {
    console.log(
      `  ${priced[0]} is out of the scoring: it is the first season with a ` +
      "price curve, so there are no earlier cuts to fit on",
    );
  }

  reportPooled(pooled, bySeason);
  reportHeadToHead(bySeason, "the points a pick returned", perPick);
  reportHeadToHead(bySeason, "precision at 20", (tally) =>
    precision(tally, 20));
  reportWeights(fitted);

  if (last) {
    reportReasons(last.season, last.week, last.picks);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
