import { describe, expect, it } from "vitest";
import {
  BENCH_HORIZON, benchChance, benchTermNames, benchWeights, expectedAdded,
  fitBenching, fitBenchingAsOf, openChance, openChances,
  type BenchCut, type BenchExample,
} from "./expectedSleepers.js";

const aCut = (over: Partial<BenchCut> = {}): BenchCut => ({
  position: "WR",
  starterGap: 0,
  backupCapital: false,
  snapTrend: 0,
  ...over,
});

/**
 * A population where the only thing separating a benched incumbent from a
 * kept one is how far under his price he is playing.
 */
const taught = (): BenchExample[] => {
  const out: BenchExample[] = [];

  for (let i = 0; i < 200; i++) {
    const behind = i % 2 === 0;
    out.push({
      cut: aCut({ starterGap: behind ? -6 : 4 }),
      season: 2020 + (i % 4),
      benched: behind,
    });
  }

  return out;
};

describe("the benching fit", () => {
  it("names one weight a term and an intercept in front", () => {
    const fit = fitBenching(taught());

    expect(fit.weights).toHaveLength(benchTermNames.length + 1);
    expect(benchWeights(fit).map((one) => one.term)).toEqual([
      ...benchTermNames,
    ]);
  });

  it("reads a starter playing under his price as the one who is benched", () => {
    const fit = fitBenching(taught());

    expect(benchChance(fit, aCut({ starterGap: -6 })))
      .toBeGreaterThan(benchChance(fit, aCut({ starterGap: 4 })));
  });

  it("keeps its chance inside nought and a half", () => {
    const fit = fitBenching(taught());

    for (const gap of [-80, -6, 0, 4, 80]) {
      const chance = benchChance(fit, aCut({ starterGap: gap }));
      expect(chance).toBeGreaterThan(0);
      expect(chance).toBeLessThanOrEqual(0.5);
    }
  });

  it("refuses a population smaller than its own terms", () => {
    expect(() => fitBenching(taught().slice(0, 3))).toThrow(/wants more than/);
  });

  it("leaves the season being scored and every later one out", () => {
    const fit = fitBenchingAsOf(2022, taught());

    expect(fit.trainedOn).toEqual([2020, 2021]);
  });
});

describe("the chance the job is open", () => {
  it("gives every week the same chance when nobody is ever benched", () => {
    const weeks = openChances({
      missPerWeek: 0.1, benchedByFour: 0, weeksLeft: 4,
    });

    expect(weeks).toHaveLength(4);
    for (const week of weeks) {
      expect(week).toBeCloseTo(0.1, 10);
    }
  });

  it("grows week by week once a benching is possible", () => {
    const weeks = openChances({
      missPerWeek: 0.1, benchedByFour: 0.2, weeksLeft: 6,
    });

    for (let i = 1; i < weeks.length; i++) {
      expect(weeks[i]!).toBeGreaterThan(weeks[i - 1]!);
    }
  });

  it("spreads a four week benching chance so four weeks add back up", () => {
    const weeks = openChances({
      missPerWeek: 0, benchedByFour: 0.36, weeksLeft: BENCH_HORIZON,
    });

    expect(weeks[BENCH_HORIZON - 1]).toBeCloseTo(0.36, 10);
  });

  it("says a job with no weeks left cannot open", () => {
    expect(openChances({
      missPerWeek: 0.2, benchedByFour: 0.2, weeksLeft: 0,
    })).toEqual([]);
    expect(openChance({
      missPerWeek: 0.2, benchedByFour: 0.2, weeksLeft: 0,
    })).toBe(0);
  });

  it("is likelier over a season than over one week of it", () => {
    const input = { missPerWeek: 0.1, benchedByFour: 0.1 };

    expect(openChance({ ...input, weeksLeft: 11 }))
      .toBeGreaterThan(openChance({ ...input, weeksLeft: 1 }));
  });
});

describe("the points a backup adds", () => {
  it("pays him the gap in every week the job is open", () => {
    const score = expectedAdded({
      missPerWeek: 0.1, benchedByFour: 0, weeksLeft: 10,
      wouldAverage: 14, currentPpg: 4,
    });

    expect(score.expectedAdded).toBeCloseTo(10, 6);
    expect(score.expectedPerGame).toBeCloseTo(1, 6);
  });

  it("pays nothing for a job worth no more than the role he has", () => {
    expect(expectedAdded({
      missPerWeek: 0.2, benchedByFour: 0.2, weeksLeft: 10,
      wouldAverage: 8, currentPpg: 8,
    }).expectedAdded).toBe(0);
  });

  it("goes negative for a backup whose own role pays better", () => {
    expect(expectedAdded({
      missPerWeek: 0.2, benchedByFour: 0.2, weeksLeft: 10,
      wouldAverage: 5, currentPpg: 9,
    }).expectedAdded).toBeLessThan(0);
  });
});
