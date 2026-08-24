import { describe, expect, it } from "vitest";
import { fitClimate, HOME, type Reading } from "./climate.js";
import { seededRng } from "../sim/rng.js";

/**
 * A few seasons of made-up weather with the shape the real thing has:
 * northern grounds colder, late weeks colder, evenings colder, and a
 * few degrees of noise on every afternoon.
 */
function madeUpReadings(): Reading[] {
  const rng = seededRng(11);
  const out: Reading[] = [];

  for (const team of ["GB", "BUF", "CHI", "PIT", "KC", "JAX", "TB", "MIA"]) {
    const north = HOME[team]!.latitude - 38;

    for (let season = 0; season < 12; season++) {
      for (let week = 1; week <= 18; week++) {
        for (const hour of [13, 20]) {
          out.push({
            team, week, hour,
            temperature: 70 - 2.2 * north - 2.1 * (week - 1) -
              (hour >= 18 ? 5 : 0) + (rng() - 0.5) * 16,
            wind: 6 + (rng() - 0.5) * 8,
          });
        }
      }
    }
  }

  return out;
}

describe("what the weather is likely to be", () => {
  const climate = fitClimate(madeUpReadings());

  it("makes the north colder than the south", () => {
    expect(climate.meanTemperature("GB", 15, 13))
      .toBeLessThan(climate.meanTemperature("MIA", 15, 13));
  });

  it("makes December colder than September", () => {
    for (const team of ["GB", "MIA"]) {
      expect(climate.meanTemperature(team, 17, 13))
        .toBeLessThan(climate.meanTemperature(team, 1, 13));
    }
  });

  it("makes an evening colder than the same afternoon", () => {
    expect(climate.meanTemperature("BUF", 15, 20))
      .toBeLessThan(climate.meanTemperature("BUF", 15, 13));
  });

  /**
   * The point of drawing rather than averaging. Buffalo in December is
   * freezing on some afternoons and mild on others, and a walk that
   * takes the average never plays either.
   */
  it("draws a spread of days rather than the same one", () => {
    const rng = seededRng(4);
    const drawn = Array.from(
      { length: 500 }, () => climate.drawTemperature("BUF", 16, 13, rng),
    );
    const middle = drawn.reduce((a, b) => a + b, 0) / drawn.length;
    const spread = Math.sqrt(
      drawn.reduce((s, x) => s + (x - middle) ** 2, 0) / drawn.length,
    );

    expect(spread).toBeGreaterThan(2);
    expect(new Set(drawn.map((d) => Math.round(d))).size).toBeGreaterThan(10);
  });

  it("never draws a day nobody could play in", () => {
    const rng = seededRng(9);

    for (let i = 0; i < 2000; i++) {
      const said = climate.drawTemperature("GB", 18, 20, rng);
      expect(said).toBeGreaterThanOrEqual(-5);
      expect(said).toBeLessThanOrEqual(105);
      expect(climate.drawWind("GB", rng)).toBeGreaterThanOrEqual(0);
    }
  });

  it("falls back to something mild at a ground it has never heard of", () => {
    expect(climate.meanTemperature("XXX", 10, 13)).toBe(60);
  });
});
