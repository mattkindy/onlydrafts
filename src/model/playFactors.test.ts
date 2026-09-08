import { describe, expect, it } from "vitest";
import { widening } from "./playFactors.js";

/** the spots one widening pass gives up, with the score held exact */
const spotsFrom = (yardline: number, toGo = 10) =>
  [...widening({ down: 1, toGo, yardline, margin: 0, secondsLeft: 1800 })]
    .filter((spot) => spot.looseness === 0);

/** how far along the field a spot is from the one being asked about */
const away = (yardline: number) => (spot: { yardline: number }) =>
  Math.abs(spot.yardline - yardline);

describe("the window a thin spot widens into", () => {
  it("gives up each state once", () => {
    for (const yardline of [3, 15, 50]) {
      const spots = spotsFrom(yardline);
      const seen = new Set(spots.map((s) => `${s.yardline}|${s.toGo}`));

      expect(seen.size).toBe(spots.length);
    }
  });

  it("takes the nearer yardline before the further one", () => {
    for (const yardline of [3, 15, 50]) {
      const furthest = new Map<number, number>();

      for (const spot of spotsFrom(yardline)) {
        const had = furthest.get(spot.toGo) ?? 0;

        expect(away(yardline)(spot)).toBeGreaterThanOrEqual(had);
        furthest.set(spot.toGo, away(yardline)(spot));
      }
    }
  });

  it("leaves no yardline behind as it grows", () => {
    for (const yardline of [3, 15, 50]) {
      const held = spotsFrom(yardline).filter((s) => s.toGo === 10);
      const reached = held.map(away(yardline));

      // one yard further at a time, so the run around the spot is unbroken
      for (let i = 1; i < reached.length; i++) {
        expect(reached[i]!).toBeGreaterThanOrEqual(reached[i - 1]!);
        expect(reached[i]! - reached[i - 1]!).toBeLessThanOrEqual(1);
      }

      expect(new Set(held.map((s) => s.yardline)).size).toBe(99);
    }
  });

  it("holds the distance while the field is still narrow", () => {
    const spots = spotsFrom(15);
    const firstLetGo = spots.findIndex((s) => s.toGo !== 10);
    const held = spots.slice(0, firstLetGo);

    expect(new Set(held.map((s) => s.yardline)))
      .toEqual(new Set([7, 8, 9, 10, 11, 12, 13, 14, 15,
        16, 17, 18, 19, 20, 21, 22, 23]));
  });

  it("keeps to the distance where it is short", () => {
    expect(spotsFrom(15, 2).every((s) => s.toGo === 2)).toBe(true);
  });

  it("reaches the fifteen from the three before it reaches the fifty five",
    () => {
      const spots = spotsFrom(3).map((s) => s.yardline);

      expect(spots.indexOf(15)).toBeLessThan(spots.indexOf(55));
      for (const yardline of [12, 13, 14, 16, 17, 18, 19, 20]) {
        expect(spots.indexOf(yardline)).toBeLessThan(spots.indexOf(55));
      }
    });

  it("takes the whole of the middle of the field before the far end", () => {
    const spots = spotsFrom(50);
    const far = spots.findIndex((s) => away(50)(s) > 20);
    const near = spots.map(away(50)).lastIndexOf(10);

    expect(near).toBeLessThan(far);
  });
});
