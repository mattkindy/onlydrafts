import { describe, expect, it } from "vitest";
import {
  ATTRIBUTES, poolVectors, similarity, type PlayerVector,
} from "./playerVector.js";

const describePlayer = (over: Partial<Record<string, number>> = {}): PlayerVector => {
  const values = new Float64Array(ATTRIBUTES.length);

  ATTRIBUTES.forEach((attribute, i) => {
    values[i] = over[attribute] ?? 0;
  });

  return { playerId: "x", name: "x", position: "WR", values };
};

describe("pooling a group", () => {
  it("gives the middle of what its players are", () => {
    const pooled = poolVectors([
      describePlayer({ height: 2 }),
      describePlayer({ height: -2 }),
    ]);

    expect(pooled[ATTRIBUTES.indexOf("height")]).toBeCloseTo(0, 10);
  });

  it("leans toward whoever is on the field more", () => {
    const tall = describePlayer({ height: 3 });
    const short = describePlayer({ height: -3 });
    const mostlyTall = poolVectors([tall, short], [9, 1]);

    expect(mostlyTall[ATTRIBUTES.indexOf("height")]).toBeGreaterThan(2);
  });

  it("returns nothing for nobody rather than dividing by nothing", () => {
    expect([...poolVectors([])].every((v) => v === 0)).toBe(true);
  });

  it("changes when the men change, which is the point", () => {
    const before = poolVectors([describePlayer({ speed: 2 }), describePlayer({ speed: 2 })]);
    const after = poolVectors([describePlayer({ speed: 2 }), describePlayer({ speed: -2 })]);

    expect(before[ATTRIBUTES.indexOf("speed")])
      .not.toBeCloseTo(after[ATTRIBUTES.indexOf("speed")]!, 3);
  });
});

describe("comparing two descriptions", () => {
  it("puts a man closest to himself", () => {
    const one = describePlayer({ height: 1, speed: -1, targetsPerGame: 2 });

    expect(similarity(one.values, one.values)).toBeCloseTo(1, 10);
  });

  it("puts opposites furthest apart", () => {
    const fast = describePlayer({ speed: -2, weight: -1 });
    const heavy = describePlayer({ speed: 2, weight: 1 });

    expect(similarity(fast.values, heavy.values)).toBeLessThan(-0.9);
  });

  it("says nothing about a man it knows nothing about", () => {
    expect(similarity(describePlayer().values, describePlayer({ speed: 1 }).values))
      .toBe(0);
  });
});
