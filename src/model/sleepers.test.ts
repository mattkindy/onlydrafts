import { describe, expect, it } from "vitest";
import {
  fitSleepers,
  fitSleepersAsOf,
  rankSleepers,
  scoreSleeper,
  shareToRead,
  sleeperTermNames,
  SLEEPER_TERMS,
  type PlayerCut,
  type SleeperExample,
} from "./sleepers.js";

const SEASONS = [2017, 2018, 2019, 2020];
const POSITIONS = ["QB", "RB", "WR", "TE"];
const PER_SEASON = 80;

/** a repeatable stand-in for a coin, so a made-up season never moves */
function jitter(season: number, i: number, salt: number): number {
  const x = Math.sin(season * 91.7 + i * 17.3 + salt * 5.9) * 10000;

  return x - Math.floor(x);
}

const cut = (over: Partial<PlayerCut> = {}): PlayerCut => ({
  season: 2019,
  week: 6,
  playerId: "one player",
  playerName: "one player",
  position: "RB",
  price: 120,
  drafted: true,
  priceMedian: 8,
  priceP10: 4,
  priceP90: 14,
  priceHitRate: 0.2,
  rawWorkShare: 0.2,
  leverageWorkShare: 0.2,
  trend: 0,
  ppgSoFar: 9,
  gamesPlayed: 6,
  pickSpread: 0.2,
  hasPickSpread: true,
  inSeasonPpg: 9,
  roleLevelPpg: 9,
  ...over,
});

/**
 * Four made-up seasons where the rest of a season is a known sum of a
 * player's share and his points so far, so what the fit ought to say
 * about him is settled before it runs.
 */
function madeUp(): SleeperExample[] {
  const examples: SleeperExample[] = [];

  for (const season of SEASONS) {
    for (let i = 0; i < PER_SEASON; i++) {
      const position = POSITIONS[i % POSITIONS.length]!;
      const price = 10 + i * 2;
      const share = 0.02 + jitter(season, i, 1) * 0.3;
      const ppgSoFar = 2 + jitter(season, i, 2) * 18;
      const his = cut({
        season,
        playerId: `${season}-${i}`,
        playerName: `player ${season} ${i}`,
        position,
        price,
        priceMedian: 18 - 2.5 * Math.log(price),
        priceP10: 10 - 2 * Math.log(price),
        priceP90: 26 - 3 * Math.log(price),
        priceHitRate: Math.max(0, 0.8 - 0.15 * Math.log(price)),
        rawWorkShare: share,
        leverageWorkShare: share * (1 + jitter(season, i, 3) * 0.2),
        trend: (jitter(season, i, 4) - 0.5) * 0.05,
        ppgSoFar,
        gamesPlayed: 4 + Math.floor(jitter(season, i, 5) * 3),
        pickSpread: jitter(season, i, 6) * 0.4,
        hasPickSpread: i % 7 !== 0,
        inSeasonPpg: 0.5 * ppgSoFar + 20 * share,
        roleLevelPpg: 30 * share,
      });
      examples.push({
        cut: his,
        restOfSeasonPpg: 40 * shareToRead(his) + 0.5 * ppgSoFar,
      });
    }
  }

  return examples;
}

const examples = madeUp();

describe("fitSleepers", () => {
  it("wants more rows than it has terms", () => {
    expect(() => fitSleepers(examples.slice(0, SLEEPER_TERMS.length)))
      .toThrow(/wants more/);
  });

  it("says which seasons it read", () => {
    expect(fitSleepers(examples).trainedOn).toEqual(SEASONS);
  });

  it("recovers a target that is a known sum of two terms", () => {
    const fit = fitSleepers(examples, { lambdaShare: 1e-6 });
    const off = examples.map((example) =>
      Math.abs(scoreSleeper(fit, example.cut).modelPpg
        - example.restOfSeasonPpg));

    expect(Math.max(...off)).toBeLessThan(0.5);
  });
});

describe("scoreSleeper", () => {
  const fit = fitSleepers(examples);

  it("adds the reasons up to the score", () => {
    const scored = scoreSleeper(fit, examples[3]!.cut);
    const summed = scored.reasons
      .reduce((sum, one) => sum + one.points, 0);

    expect(summed).toBeCloseTo(scored.score, 10);
    expect(scored.pricePpg + scored.score).toBeCloseTo(scored.modelPpg, 10);
  });

  it("names every term that is not about his price", () => {
    const scored = scoreSleeper(fit, examples[3]!.cut);

    expect(scored.reasons.map((one) => one.term).sort()).toEqual([
      "games played", "leverage lift", "pick spread",
      "points a game so far", "trend", "work share",
    ]);
  });

  it("puts the biggest reason first", () => {
    const scored = scoreSleeper(fit, examples[11]!.cut);
    const sizes = scored.reasons.map((one) => Math.abs(one.points));

    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
  });

  it("claims nothing against the board for a whole position at once", () => {
    for (const position of POSITIONS) {
      const scores = examples
        .filter((example) => example.cut.position === position)
        .map((example) => scoreSleeper(fit, example.cut).score);
      const middle = scores.reduce((sum, one) => sum + one, 0) / scores.length;

      expect(middle).toBeCloseTo(0, 8);
    }
  });

  it("prefers the busier of two players who cost the same", () => {
    const lean = cut({ rawWorkShare: 0.05, leverageWorkShare: 0.05 });
    const busy = cut({ rawWorkShare: 0.28, leverageWorkShare: 0.28 });

    expect(scoreSleeper(fit, busy).score)
      .toBeGreaterThan(scoreSleeper(fit, lean).score);
  });
});

describe("the in-season term set", () => {
  it("reads two more terms than the shipped set", () => {
    expect(sleeperTermNames("with in-season").length)
      .toBe(SLEEPER_TERMS.length + 2);
  });

  it("gives the two extra terms reasons of their own", () => {
    const fit = fitSleepers(examples, { terms: "with in-season" });
    const terms = scoreSleeper(fit, examples[3]!.cut).reasons
      .map((one) => one.term);

    expect(terms).toContain("in-season level");
    expect(terms).toContain("role level");
  });

  it("leaves the shipped fit alone", () => {
    expect(fitSleepers(examples).weights.length).toBe(SLEEPER_TERMS.length + 1);
  });
});

describe("rankSleepers", () => {
  it("puts the biggest claim against the board first", () => {
    const fit = fitSleepers(examples);
    const ranked = rankSleepers(fit, examples.map((one) => one.cut));
    const scores = ranked.map((one) => one.score);

    expect(ranked.length).toBe(examples.length);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });
});

describe("fitSleepersAsOf", () => {
  it("reads no season from the one it is asked about or later", () => {
    expect(fitSleepersAsOf(2019, examples).trainedOn).toEqual([2017, 2018]);
  });

  it("does not move when a later season's outcome is altered", () => {
    const meddled = examples.map((example) =>
      example.cut.season < 2019
        ? example
        : { ...example, restOfSeasonPpg: example.restOfSeasonPpg * 3 + 11 });

    expect(fitSleepersAsOf(2019, meddled).weights)
      .toEqual(fitSleepersAsOf(2019, examples).weights);
  });

  it("does not move when a later season gains players", () => {
    const extra = examples
      .filter((example) => example.cut.season === 2020)
      .map((example) => ({
        ...example,
        cut: { ...example.cut, playerId: `${example.cut.playerId} again` },
        restOfSeasonPpg: 0,
      }));

    expect(fitSleepersAsOf(2019, [...examples, ...extra]).weights)
      .toEqual(fitSleepersAsOf(2019, examples).weights);
  });

  it("refuses a season with nothing before it", () => {
    expect(() => fitSleepersAsOf(2017, examples)).toThrow(/wants more/);
  });
});

describe("shareToRead", () => {
  it("reads the leverage weighted share for a rotational player", () => {
    const rotational = cut({ rawWorkShare: 0.09, leverageWorkShare: 0.13 });

    expect(shareToRead(rotational)).toBe(0.13);
  });

  it("reads the raw share for everybody above the cut", () => {
    const starter = cut({ rawWorkShare: 0.22, leverageWorkShare: 0.26 });

    expect(shareToRead(starter)).toBe(0.22);
  });
});
