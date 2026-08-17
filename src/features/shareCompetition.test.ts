import { describe, expect, it } from "vitest";
import { divideAmong } from "./shareCompetition.js";

const at = (shares: Map<string, number>, id: string) => shares.get(id) ?? 0;

describe("dividing a position's work", () => {
  it("gives out exactly what there is to give", () => {
    const shares = divideAmong(
      [{ playerId: "a", standing: 0.2 }, { playerId: "b", standing: 0.05 }], 0.3,
    );
    const total = [...shares.values()].reduce((a, b) => a + b, 0);

    expect(total).toBeCloseTo(0.3, 6);
  });

  it("makes the same man worth less behind a better one", () => {
    const behindGood = divideAmong(
      [{ playerId: "him", standing: 0.08 }, { playerId: "star", standing: 0.25 }], 0.33,
    );
    const behindPlain = divideAmong(
      [{ playerId: "him", standing: 0.08 }, { playerId: "plain", standing: 0.09 }], 0.33,
    );

    expect(at(behindGood, "him")).toBeLessThan(at(behindPlain, "him"));
  });

  it("gives a man on his own the lot, whatever he has shown", () => {
    const shares = divideAmong([{ playerId: "only", standing: 0.01 }], 0.25);

    expect(at(shares, "only")).toBeCloseTo(0.25, 6);
  });

  it("splits it in proportion to what they have shown", () => {
    const shares = divideAmong(
      [{ playerId: "good", standing: 0.2 }, { playerId: "poor", standing: 0.1 }], 0.3,
    );

    expect(at(shares, "good") / at(shares, "poor")).toBeCloseTo(2, 3);
  });

  it("can be told to favour the better man beyond that", () => {
    const shares = divideAmong(
      [{ playerId: "good", standing: 0.2 }, { playerId: "poor", standing: 0.1 }], 0.3,
      { sharpness: 2, floor: 0.004 },
    );

    expect(at(shares, "good") / at(shares, "poor")).toBeCloseTo(4, 3);
  });
});
