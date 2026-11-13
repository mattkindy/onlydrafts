import { describe, expect, it } from "vitest";
import { keepsTheJob, madeOverExpected } from "./kickerKeep.js";

describe("madeOverExpected", () => {
  it("reads a miss from 55 as costing less than a miss from 25", () => {
    const long = madeOverExpected({ fgmiss_50_59: 1 });
    const short = madeOverExpected({ fgmiss_20_29: 1 });

    expect(long).toBeCloseTo(-0.68);
    expect(short).toBeCloseTo(-0.97);
  });

  it("leaves out the rollups a league reads, so nothing counts twice", () => {
    expect(madeOverExpected({ fgm_50_59: 1, fgm_50p: 1, fgm: 1 }))
      .toBeCloseTo(0.32);
  });
});

describe("keepsTheJob", () => {
  it("is the board's old 15.3 of 17 for a kicker who has not kicked", () => {
    expect(17 * keepsTheJob(0)).toBeCloseTo(15.3, 0);
  });

  it("falls as he misses and rises as he makes them", () => {
    expect(keepsTheJob(-3)).toBeLessThan(0.75);
    expect(keepsTheJob(-3)).toBeLessThan(keepsTheJob(0));
    expect(keepsTheJob(2)).toBeGreaterThan(0.95);
  });

  it("stops moving past what the fit saw", () => {
    expect(keepsTheJob(-20)).toBe(keepsTheJob(-6));
  });
});
