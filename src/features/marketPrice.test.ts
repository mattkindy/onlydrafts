import { describe, expect, it } from "vitest";
import {
  fitMarketPrice,
  marketPriceAsOf,
  seasonPrices,
  type PriceOutcome,
  type PriceFit,
  type SeasonPrices,
} from "./marketPrice.js";

const SEASONS = [2018, 2019, 2020, 2021, 2022];
const PER_SEASON = 150;

/** what a made-up board pays at the top of the draft, falling with price */
const onTheLine = (adp: number) => 20 - 3 * Math.log(adp);

/** a repeatable stand-in for a coin, so a made-up board never moves */
function jitter(season: number, i: number, salt: number): number {
  const x = Math.sin(season * 97.13 + i * 13.37 + salt * 3.11) * 10000;

  return x - Math.floor(x);
}

/**
 * A board of 150 players a season over five seasons, priced 1 to 150,
 * whose points a game come from `pointsAt`. Everything is made up so the
 * answer is known before the fit runs.
 */
function board(
  pointsAt: (adp: number, season: number, i: number) => number,
  options: { position?: string; hitAbove?: number } = {},
): PriceOutcome[] {
  const rows: PriceOutcome[] = [];

  for (const season of SEASONS) {
    for (let i = 0; i < PER_SEASON; i++) {
      const adp = i + 1;
      const ppg = pointsAt(adp, season, i);
      rows.push({
        season,
        playerName: `player ${season} ${i}`,
        position: options.position ?? "RB",
        adp,
        ppg,
        games: 17,
        hit: ppg >= (options.hitAbove ?? Infinity),
      });
    }
  }

  return rows;
}

const FITS: PriceFit[] = ["windowed", "logLinear"];

describe("fitMarketPrice", () => {
  it("recovers a straight line on log price", () => {
    for (const fit of FITS) {
      const fitted = fitMarketPrice(board(onTheLine), fit);

      expect(fitted.expectedPpg("RB", 10)).toBeCloseTo(onTheLine(10), 0);
      expect(fitted.expectedPpg("RB", 100)).toBeCloseTo(onTheLine(100), 0);
    }
  });

  it("never says a later pick is worth more", () => {
    // the cheap end is noise on purpose, and a fit that followed it up
    // would be telling a drafter to reach past the player he wants
    const noisy = board((adp, _season, i) =>
      adp < 60 ? onTheLine(adp) : 5 + (i % 7) * 3,
    );

    for (const fit of FITS) {
      const fitted = fitMarketPrice(noisy, fit);
      let previous = Infinity;

      for (let adp = 1; adp <= 200; adp++) {
        const said = fitted.expectedPpg("RB", adp);
        expect(said).toBeLessThanOrEqual(previous + 1e-9);
        previous = said;
      }
    }
  });

  it("keeps the quantiles in order and monotone in price", () => {
    const fitted = fitMarketPrice(
      board((adp, _season, i) => onTheLine(adp) + (i % 5)),
    );
    const levels = ["p10", "p25", "p50", "p75", "p90"] as const;
    const previous: Record<string, number> = {};

    for (let adp = 1; adp <= 200; adp += 3) {
      const at = fitted.quantiles("RB", adp);

      for (let i = 1; i < levels.length; i++) {
        expect(at[levels[i]!]).toBeGreaterThanOrEqual(at[levels[i - 1]!]);
      }

      for (const level of levels) {
        expect(at[level]).toBeLessThanOrEqual(
          (previous[level] ?? Infinity) + 1e-9,
        );
        previous[level] = at[level];
      }
    }
  });

  it("puts the median on the line and the mean above it when a fifth hit big", () => {
    // a fifth of the board at any price beats it by 15 and the rest land
    // on it, so the mean has to come out three points above the median
    const fitted = fitMarketPrice(
      board(
        (adp, season, i) =>
          onTheLine(adp) + (jitter(season, i, 1) > 0.8 ? 15 : 0),
      ),
    );
    const at = fitted.quantiles("RB", 110);
    const said = fitted.expectedPpg("RB", 110);

    expect(at.p50).toBeCloseTo(onTheLine(110), 0);
    expect(at.p90 - at.p50).toBeGreaterThan(13);
    expect(said - at.p50).toBeGreaterThan(1.5);
    expect(said - at.p50).toBeLessThan(5);
  });

  it("reads the hit rate off who actually hit", () => {
    // everybody inside the first 24 picks starts and nobody past it does
    const fitted = fitMarketPrice(
      board((adp) => (adp <= 24 ? 18 : 6), { hitAbove: 15 }),
    );

    expect(fitted.hitRate("RB", 6)).toBeCloseTo(1, 1);
    expect(fitted.hitRate("RB", 150)).toBeCloseTo(0, 1);
    expect(fitted.hitRate("RB", 6)).toBeGreaterThan(fitted.hitRate("RB", 60));
  });

  it("gives each position its own curve and says what is behind it", () => {
    const backs = board(onTheLine);
    const ends = board((adp) => 10 - Math.log(adp), { position: "TE" });
    const fitted = fitMarketPrice([...backs, ...ends]);

    expect(fitted.expectedPpg("RB", 40)).toBeGreaterThan(
      fitted.expectedPpg("TE", 40),
    );

    const support = fitted.support("RB", 40);
    expect(support.seasons).toBe(SEASONS.length);
    expect(support.players).toBeGreaterThan(40);
    expect(support.effectivePlayers).toBeLessThan(support.players);
    expect(support.lowestAdp).toBeLessThan(40);
    expect(support.highestAdp).toBeGreaterThan(40);
  });

  it("falls back to the pooled curve for a position it never saw", () => {
    const fitted = fitMarketPrice(board(onTheLine));

    expect(fitted.hitRate("K", 40)).toBeGreaterThanOrEqual(0);
    expect(fitted.expectedPpg("K", 10)).toBeGreaterThan(
      fitted.expectedPpg("K", 100),
    );
  });

  it("says which seasons it read", () => {
    expect(fitMarketPrice(board(() => 10)).trainedOn).toEqual(SEASONS);
  });

  it("wants at least one player", () => {
    expect(() => fitMarketPrice([])).toThrow(/at least one/);
  });
});

/**
 * A board where the widest fifth of the spreads are the players who went
 * on to score 15 points a game more than their price said, and nobody
 * else beat it at all.
 */
function spreadTellsTheTruth(): PriceOutcome[] {
  return board((adp, season, i) => {
    const loud = jitter(season, i, 2);

    return onTheLine(adp) + loud + (loud > 0.8 ? 15 : 0);
  }).map((row, index) => ({
    ...row,
    spread: {
      stdev: 1 + 8 * jitter(row.season, index % PER_SEASON, 2),
      draftedShare: 0.2 + 0.6 * jitter(row.season, index % PER_SEASON, 5),
    },
  }));
}

/** the same board with the spread and the outcome pulled from two hats */
function spreadIsNoise(): PriceOutcome[] {
  return spreadTellsTheTruth().map((row, index) => ({
    ...row,
    spread: {
      stdev: 1 + 8 * jitter(row.season, index % PER_SEASON, 9),
      draftedShare: row.spread?.draftedShare ?? 0.5,
    },
  }));
}

describe("disagreement", () => {
  it("finds a wide spread that really does mean a fatter tail", () => {
    const finding = fitMarketPrice(spreadTellsTheTruth()).disagreement;
    const spread = finding.terciles.filter((one) => one.measure === "spread");
    const top = spread[spread.length - 1]!;
    const bottom = spread[0]!;

    expect(spread.every((one) => one.players > 100)).toBe(true);
    expect(top.meanPlace).toBeGreaterThan(bottom.meanPlace);
    expect(top.aboveP90).toBeGreaterThan(bottom.aboveP90 + 0.2);
    expect(finding.tailZ.spread).toBeGreaterThan(2);
    expect(finding.movesTheTail).toBe(true);
  });

  it("calls it flat where the spread has nothing to do with the outcome", () => {
    const finding = fitMarketPrice(spreadIsNoise()).disagreement;

    expect(Math.abs(finding.tailZ.spread)).toBeLessThan(2);
    expect(finding.movesTheTail).toBe(false);
  });

  it("keeps the thirds level on price, which is what makes them comparable", () => {
    const finding = fitMarketPrice(spreadTellsTheTruth()).disagreement;

    for (const tercile of finding.terciles) {
      expect(tercile.meanPricePlace).toBeGreaterThan(0.35);
      expect(tercile.meanPricePlace).toBeLessThan(0.65);
    }
  });

  it("says nothing where no board gave a spread", () => {
    const finding = fitMarketPrice(board(onTheLine)).disagreement;

    expect(finding.movesTheTail).toBe(false);
    expect(finding.movesTheHitRate).toBe(false);
    expect(finding.terciles.every((one) => one.players === 0)).toBe(true);
  });
});

// each of these reads a decade of drafts off disk and fits them, which
// runs close to the five second default on a quiet machine and over it
// on a busy one
describe("marketPriceAsOf", { timeout: 30_000 }, () => {
  it("reads nothing from the season it is asked about", async () => {
    const fitted = await marketPriceAsOf(2019);

    expect(fitted.trainedOn).toEqual([2015, 2016, 2017, 2018]);
  });

  it("refuses a season with too little behind it", async () => {
    await expect(marketPriceAsOf(2016)).rejects.toThrow(/earlier/);
  });

  it("fills a handed-in cache and gives the same curve off it", async () => {
    const counted = new Map<number, SeasonPrices | null>();
    const cold = await marketPriceAsOf(2019, { counted });

    expect([...counted.keys()].sort()).toEqual([2015, 2016, 2017, 2018]);

    const warm = await marketPriceAsOf(2019, { counted });

    expect(warm.trainedOn).toEqual(cold.trainedOn);
    expect(warm.expectedPpg("RB", 40)).toBe(cold.expectedPpg("RB", 40));
  });

  it("leaves out a season the cache says has nothing", async () => {
    const counted = new Map<number, SeasonPrices | null>([[2017, null]]);
    const fitted = await marketPriceAsOf(2019, { counted });

    expect(fitted.trainedOn).toEqual([2015, 2016, 2018]);
  });
});

describe("seasonPrices", () => {
  it("prices a season and finds almost everybody on it", async () => {
    const priced = await seasonPrices(2023);

    expect(priced.rows.length).toBeGreaterThan(100);
    expect(priced.unmatched).toBeLessThan(5);
    expect(priced.rows.every((row) => row.adp > 0)).toBe(true);
    expect(priced.rows.some((row) => row.hit)).toBe(true);
    expect(priced.rows.every((row) => row.spread !== undefined)).toBe(true);
  });

  it("counts a starter tier the size the league starts", async () => {
    const priced = await seasonPrices(2023);
    const hits = (position: string) =>
      priced.rows.filter((row) => row.position === position && row.hit).length;

    expect(hits("QB")).toBeLessThanOrEqual(12);
    expect(hits("RB")).toBeLessThanOrEqual(24);
    expect(hits("WR")).toBeLessThanOrEqual(24);
    expect(hits("TE")).toBeLessThanOrEqual(12);
  });
});
