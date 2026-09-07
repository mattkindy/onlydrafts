import { describe, expect, it } from "vitest";
import { bestMix, mixPoints, shareGrid, type MixEntry } from "./mixWeights.js";

describe("mixPoints", () => {
  it("averages the parts at their weights", () => {
    expect(mixPoints([10, 20, 30], [0.5, 0.25, 0.25])).toBe(17.5);
  });
});

describe("shareGrid", () => {
  it("splits one whole every way it can", () => {
    const grid = shareGrid(3, 0.25);
    expect(grid).toHaveLength(15);

    for (const split of grid) {
      expect(split.reduce((s, w) => s + w, 0)).toBeCloseTo(1, 6);
    }
  });

  it("puts the evenest split first", () => {
    expect(shareGrid(2, 0.5)[0]).toEqual([0.5, 0.5]);
  });
});

/** the third voice knows the week and the first two do not */
const thirdIsRight: MixEntry[][] = [
  [
    { parts: [20, 20, 2], actual: 2 },
    { parts: [2, 2, 20], actual: 25 },
  ],
];

describe("bestMix", () => {
  it("puts the weight on the voice that gets the calls right", () => {
    const weights = bestMix(thirdIsRight, shareGrid(3, 0.25));
    expect(weights[2]!).toBeGreaterThan(weights[0]! + weights[1]!);
  });

  it("keeps the first candidate when nothing separates them", () => {
    const flat: MixEntry[][] = [
      [
        { parts: [10, 10], actual: 5 },
        { parts: [5, 5], actual: 1 },
      ],
    ];
    expect(bestMix(flat, [[0.5, 0.5], [1, 0]])).toEqual([0.5, 0.5]);
  });
});
