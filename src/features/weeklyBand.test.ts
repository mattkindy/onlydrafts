import { describe, expect, it } from "vitest";
import { bandFor, ENOUGH_RUNS } from "./weeklyBand.js";
import { spreadOf } from "./runSpread.js";
import type { RunSpread } from "./runSpread.js";

const pooled = { floor: 4, ceiling: 18 };
const dealt = (runs: number): RunSpread =>
  spreadOf(Array.from({ length: runs }, (_, i) => 5 + i / 2));

describe("which band a man gets", () => {
  it("takes the walk's own games when it played him", () => {
    const walk = dealt(40);
    const band = bandFor(walk, pooled, 1);

    expect(band.from).toBe("walk");
    expect(band.floor).toBeCloseTo(walk.p10, 6);
    expect(band.ceiling).toBeCloseTo(walk.p90, 6);
  });

  it("stretches the walk's band around its middle", () => {
    const walk = dealt(40);
    const band = bandFor(walk, pooled, 1.2);

    expect(band.floor).toBeCloseTo(walk.p50 + (walk.p10 - walk.p50) * 1.2, 6);
    expect(band.ceiling).toBeCloseTo(walk.p50 + (walk.p90 - walk.p50) * 1.2, 6);
  });

  it("keeps a floor off the wrong side of zero", () => {
    const walk = spreadOf(Array.from({ length: 40 }, (_, i) => i / 20));

    expect(bandFor(walk, pooled, 3).floor).toBe(0);
  });

  it("falls back to the pooled band for a man the walk never played", () => {
    expect(bandFor(undefined, pooled)).toEqual({ ...pooled, from: "pooled" });
  });

  it("falls back when too few games were dealt to read a tenth", () => {
    expect(bandFor(dealt(ENOUGH_RUNS - 1), pooled).from).toBe("pooled");
    expect(bandFor(dealt(ENOUGH_RUNS), pooled).from).toBe("walk");
  });

  it("falls back for a man the walk scored at nothing", () => {
    expect(bandFor(spreadOf(new Array(40).fill(0)), pooled).from).toBe("pooled");
  });
});
