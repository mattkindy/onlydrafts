/**
 * Scores the market price model before anybody spends an hour on a
 * backtest with it. Prints the fitted curve beside the raw historical
 * means, whether the hit rate means what it says, what the drafters' own
 * disagreement is worth, and how many players and seasons each number
 * rests on.
 *
 * Every season is scored against a curve fitted only on the seasons
 * before it, which is what the module's API forces anyway.
 *
 * Run: npx tsx scripts/marketPriceProbe.ts [--seasons 2015-2025]
 */

import {
  fitMarketPrice,
  marketPriceAsOf,
  seasonPrices,
  PRICED_POSITIONS,
  STARTER_TIER,
  SHIPPED_FIT,
  type MarketPrice,
  type PriceFit,
  type PriceOutcome,
  type SeasonPrices,
} from "../src/features/marketPrice.js";
import { seasonsAsked } from "../src/data/seasons.js";
import { rmse, spearman } from "../src/backtest/metrics.js";

/** the price bands the rest of the model already cuts the board at */
const BANDS = [
  { name: "1-12", from: 1, to: 12 },
  { name: "13-24", from: 13, to: 24 },
  { name: "25-48", from: 25, to: 48 },
  { name: "49-96", from: 49, to: 96 },
  { name: "97-160", from: 97, to: 160 },
  { name: "161+", from: 161, to: 400 },
];

/** where in a band the curve is read, since a band is not a point */
const bandMiddle = (band: { from: number; to: number }) =>
  Math.exp((Math.log(band.from) + Math.log(band.to)) / 2);

const pct = (share: number) => `${(share * 100).toFixed(1)}%`;
const num = (value: number, places = 2) => value.toFixed(places);

const mean = (values: number[]) =>
  values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;

function quantileOf(values: number[], at: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const place = at * (sorted.length - 1);
  const lower = Math.floor(place);
  const frac = place - lower;

  return (
    (sorted[lower] ?? 0) * (1 - frac) +
    (sorted[Math.min(sorted.length - 1, lower + 1)] ?? 0) * frac
  );
}

/**
 * How far the mean comes out above the median, against how wide the
 * middle eight tenths run. Positive is a right tail, and zero is a
 * distribution a standard deviation would have described as well.
 */
function skewOf(values: number[]): number {
  const width = quantileOf(values, 0.9) - quantileOf(values, 0.1);

  return width <= 0 ? 0 : (mean(values) - quantileOf(values, 0.5)) / width;
}

/* ---------- the curve against the players it was fitted on ---------- */

function curveTable(fitted: MarketPrice, rows: PriceOutcome[]) {
  console.log(
    "\nThe fitted curve against the players themselves. `fit` is what the\n" +
    "curve says at the middle of the band, `raw` is what the players in\n" +
    "that band actually averaged, p10 to p90 are where they landed, and\n" +
    "`said` and `was` are the hit rate the same two ways. `skew` is how\n" +
    "far the raw mean beat the raw median, over the middle eight tenths,\n" +
    "for points a game and then for the season total, and `wide` is p10\n" +
    "to p90 as a multiple of the median.",
  );
  console.log(
    "pos band      fit   raw   p10   p25   p50   p75   p90  said   was" +
    "  skew  tot  wide     n  eff  yrs  prices",
  );

  for (const position of PRICED_POSITIONS) {
    for (const band of BANDS) {
      const inside = rows.filter(
        (row) =>
          row.position === position &&
          row.adp >= band.from &&
          row.adp <= band.to,
      );

      if (inside.length === 0) {
        continue;
      }

      const at = bandMiddle(band);
      const quantiles = fitted.quantiles(position, at);
      const support = fitted.support(position, at);

      console.log(
        `${position.padEnd(4)}${band.name.padEnd(7)}` +
        `${num(fitted.expectedPpg(position, at)).padStart(5)}` +
        `${num(mean(inside.map((row) => row.ppg))).padStart(6)}` +
        `${num(quantiles.p10, 1).padStart(6)}` +
        `${num(quantiles.p25, 1).padStart(6)}` +
        `${num(quantiles.p50, 1).padStart(6)}` +
        `${num(quantiles.p75, 1).padStart(6)}` +
        `${num(quantiles.p90, 1).padStart(6)}` +
        `${pct(fitted.hitRate(position, at)).padStart(6)}` +
        `${pct(mean(inside.map((row) => (row.hit ? 1 : 0)))).padStart(6)}` +
        `${num(skewOf(inside.map((row) => row.ppg))).padStart(6)}` +
        `${num(skewOf(inside.map((row) => row.ppg * row.games))).padStart(5)}` +
        `${num((quantiles.p90 - quantiles.p10) / quantiles.p50).padStart(6)}` +
        `${String(support.players).padStart(6)}` +
        `${num(support.effectivePlayers, 0).padStart(5)}` +
        `${String(support.seasons).padStart(5)}` +
        `  ${num(support.lowestAdp, 0)}-${num(support.highestAdp, 0)}`,
      );
    }
  }
}

/* ---------- each season against a curve that could not see it ---------- */

interface Scored {
  fit: PriceFit;
  predicted: number[];
  actual: number[];
  /** the predicted hit rate and whether he hit, for the calibration table */
  hitPairs: { predicted: number; hit: boolean }[];
  /** the mean error per position, so a tilted fit shows up */
  biasBy: Record<string, number[]>;
  /** one season at a time, because 11 of them are not many */
  bySeason: { season: number; rmse: number; order: number }[];
}

/** the youngest curve worth scoring needs this many seasons behind it */
const MIN_BEHIND = 3;

function scoreForward(
  priced: Map<number, SeasonPrices>,
  seasons: number[],
  fit: PriceFit,
): Scored {
  const scored: Scored = {
    fit,
    predicted: [],
    actual: [],
    hitPairs: [],
    biasBy: {},
    bySeason: [],
  };

  for (const season of seasons) {
    const earlier = seasons.filter((one) => one < season);

    if (earlier.length < MIN_BEHIND) {
      continue;
    }

    const training = earlier.flatMap((one) => priced.get(one)?.rows ?? []);
    const fitted = fitMarketPrice(training, fit);
    const said: number[] = [];
    const was: number[] = [];

    for (const row of priced.get(season)?.rows ?? []) {
      said.push(fitted.expectedPpg(row.position, row.adp));
      was.push(row.ppg);
      scored.hitPairs.push({
        predicted: fitted.hitRate(row.position, row.adp),
        hit: row.hit,
      });
      scored.biasBy[row.position] = [
        ...(scored.biasBy[row.position] ?? []),
        fitted.expectedPpg(row.position, row.adp) - row.ppg,
      ];
    }

    scored.predicted.push(...said);
    scored.actual.push(...was);
    scored.bySeason.push({
      season,
      rmse: rmse(said, was),
      order: spearman(said, was),
    });
  }

  return scored;
}

function fitComparison(scores: Scored[]) {
  console.log(
    "\nThe two fits, each season scored against a curve fitted only on the\n" +
    "seasons before it. `bias` is what the fit said minus what happened.",
  );
  console.log(
    "fit        rmse  order   QB bias  RB bias  WR bias  TE bias     n",
  );

  for (const scored of scores) {
    const bias = PRICED_POSITIONS.map((position) =>
      num(mean(scored.biasBy[position] ?? [0]), 2).padStart(9),
    ).join("");
    console.log(
      `${scored.fit.padEnd(10)}` +
      `${num(rmse(scored.predicted, scored.actual)).padStart(5)}` +
      `${num(spearman(scored.predicted, scored.actual), 3).padStart(7)}` +
      `${bias}` +
      `${String(scored.predicted.length).padStart(6)}`,
    );
  }

  const [first, second] = scores;

  if (!first || !second) {
    return;
  }

  console.log(
    `\nseason by season, ${first.fit} against ${second.fit}, ` +
    "since 11 seasons is not many",
  );
  console.log("season  rmse           order");

  for (let i = 0; i < first.bySeason.length; i++) {
    const a = first.bySeason[i]!;
    const b = second.bySeason[i]!;
    console.log(
      `${String(a.season).padEnd(8)}${num(a.rmse).padStart(5)}` +
      `${num(b.rmse).padStart(7)}` +
      `${num(a.order, 3).padStart(10)}${num(b.order, 3).padStart(7)}`,
    );
  }

  const wonOnOrder = first.bySeason.filter(
    (a, i) => a.order > (second.bySeason[i]?.order ?? 0),
  ).length;
  console.log(
    `${first.fit} orders better in ${wonOnOrder} of ` +
    `${first.bySeason.length} seasons`,
  );
}

/* ---------- does the hit rate mean what it says ---------- */

const CALIBRATION_CUTS = [0, 0.1, 0.2, 0.3, 0.45, 0.6, 1.01];

function calibration(scored: Scored) {
  console.log(
    "\nCalibration of the hit rate, over the same seasons. Players bucketed\n" +
    "by the chance the curve gave them, against how often they finished\n" +
    `inside the tier (QB${STARTER_TIER["QB"]} RB${STARTER_TIER["RB"]} ` +
    `WR${STARTER_TIER["WR"]} TE${STARTER_TIER["TE"]}).`,
  );
  console.log("bucket         said  really     n");

  for (let i = 0; i + 1 < CALIBRATION_CUTS.length; i++) {
    const from = CALIBRATION_CUTS[i]!;
    const to = CALIBRATION_CUTS[i + 1]!;
    const inside = scored.hitPairs.filter(
      (pair) => pair.predicted >= from && pair.predicted < to,
    );

    if (inside.length === 0) {
      continue;
    }

    console.log(
      `${`${pct(from)} to ${pct(Math.min(1, to))}`.padEnd(15)}` +
      `${pct(mean(inside.map((pair) => pair.predicted))).padStart(5)}` +
      `${pct(mean(inside.map((pair) => (pair.hit ? 1 : 0)))).padStart(8)}` +
      `${String(inside.length).padStart(6)}`,
    );
  }
}

/* ---------- is the room's own argument telling you anything ---------- */

function disagreement(fitted: MarketPrice) {
  const finding = fitted.disagreement;
  console.log(
    "\nDrafter disagreement at a fixed price. Players are cut into thirds by\n" +
    "how wide their pick ran (spread) and by how many drafts took them\n" +
    "(drafted), both ranked against the other players on the same shelf.\n" +
    "`place` is where a player landed among those neighbours, so half is\n" +
    "nothing, `>p90` is how often he beat the 90th percentile of his own\n" +
    "price, and `price` is where his own price sat in the window, which\n" +
    "has to be near half or the thirds are not level on price after all.",
  );
  console.log("measure  third  players  place   >p90   hit%  price");

  for (const tercile of finding.terciles) {
    console.log(
      `${tercile.measure.padEnd(9)}${String(tercile.tercile).padEnd(7)}` +
      `${String(tercile.players).padStart(7)}` +
      `${num(tercile.meanPlace, 3).padStart(7)}` +
      `${pct(tercile.aboveP90).padStart(7)}` +
      `${pct(tercile.hitRate).padStart(7)}` +
      `${num(tercile.meanPricePlace, 3).padStart(7)}`,
    );
  }

  console.log("\ntop third against bottom third, in standard errors:");
  console.log(
    `right tail   spread ${num(finding.tailZ.spread, 2)}` +
    `   drafted ${num(finding.tailZ.drafted, 2)}`,
  );
  console.log(
    `hit rate     spread ${num(finding.hitZ.spread, 2)}` +
    `   drafted ${num(finding.hitZ.drafted, 2)}`,
  );
  console.log(
    finding.movesTheTail
      ? "\nThe right tail moves by two standard errors or more, so at a fixed" +
        " price\na wider spread does say something about how far a player can" +
        " beat it."
      : "\nThe right tail does not move by two standard errors. At a fixed" +
        " price, how\nmuch the room argued about a player says nothing about" +
        " how far he beat it.",
  );
  console.log(
    finding.movesTheHitRate
      ? "The hit rate does move, so the room's argument is about whether a" +
        " player\nis a starter at all rather than about his upside. Read the" +
        " sign above:\nnegative means the players they argued about were the" +
        " worse bets."
      : "The hit rate does not move either, so neither measure is worth" +
        " feeding forward.",
  );
}

/* ---------- what the numbers rest on ---------- */

function coverage(priced: Map<number, SeasonPrices>) {
  console.log("\nWhat each season contributed.");
  console.log("season  priced  never played  unmatched  hits  with spread");

  for (const [season, prices] of [...priced].sort((a, b) => a[0] - b[0])) {
    console.log(
      `${String(season).padEnd(8)}${String(prices.rows.length).padStart(6)}` +
      `${String(prices.neverPlayed).padStart(14)}` +
      `${String(prices.unmatched).padStart(11)}` +
      `${String(prices.rows.filter((row) => row.hit).length).padStart(6)}` +
      `${String(prices.rows.filter((row) => row.spread).length).padStart(13)}`,
    );
  }
}

async function main() {
  const started = Date.now();
  const seasons = seasonsAsked(process.argv, [
    2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025,
  ]);
  const priced = new Map<number, SeasonPrices>();

  for (const season of seasons) {
    const prices = await seasonPrices(season).catch(() => null);

    if (prices) {
      priced.set(season, prices);
    }
  }

  const all = [...priced.values()].flatMap((prices) => prices.rows);
  const counted = [...priced.keys()].sort((a, b) => a - b);
  console.log(
    `${all.length} priced players over ${counted.length} seasons, ` +
    `${counted[0]} to ${counted[counted.length - 1]}, PPR points a game`,
  );

  const fits: PriceFit[] = ["windowed", "logLinear"];
  const scores = fits.map((fit) => scoreForward(priced, counted, fit));
  fitComparison(scores);

  const shipped = scores.find((scored) => scored.fit === SHIPPED_FIT);

  if (shipped) {
    calibration(shipped);
  }

  // The season after the last one on disk is what a caller would ask
  // about next, so this is the curve the model hands out today.
  const next = (counted[counted.length - 1] ?? 2025) + 1;
  const fitted = await marketPriceAsOf(next);
  const trained = fitted.trainedOn;
  console.log(
    `\nthe curve for ${next}, fitted on ${trained.length} seasons ` +
    `(${trained[0]} to ${trained[trained.length - 1]})`,
  );
  curveTable(fitted, all.filter((row) => trained.includes(row.season)));

  disagreement(fitMarketPrice(all));
  coverage(priced);
  console.log(`\n${Date.now() - started}ms`);
}

await main();
