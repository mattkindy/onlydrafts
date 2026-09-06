import { describe, expect, it } from "vitest";
import { addPairs, emptyTally, pairRate, type PairEntry } from "./pairs.js";

function tallyOf(entries: PairEntry[]) {
  const tally = emptyTally();
  addPairs(tally, entries);
  return tally;
}

describe("addPairs", () => {
  it("counts every pair once", () => {
    const tally = tallyOf([
      { predicted: 1, actual: 1 },
      { predicted: 2, actual: 2 },
      { predicted: 3, actual: 3 },
    ]);

    expect(tally.get("all")!.total).toBe(3);
    expect(pairRate(tally, "all")).toBe(1);
  });

  it("credits the pair when the higher projection scored more", () => {
    const tally = tallyOf([
      { predicted: 10, actual: 4 },
      { predicted: 5, actual: 20 },
    ]);

    expect(pairRate(tally, "all")).toBe(0);
  });

  it("splits the credit when both men scored the same", () => {
    const tally = tallyOf([
      { predicted: 10, actual: 7 },
      { predicted: 5, actual: 7 },
    ]);

    expect(pairRate(tally, "all")).toBe(0.5);
  });

  it("leaves out a pair the method did not choose between", () => {
    const tally = tallyOf([
      { predicted: 8, actual: 1 },
      { predicted: 8, actual: 30 },
    ]);

    expect(tally.get("all")!.total).toBe(0);
    expect(pairRate(tally, "all")).toBeNaN();
  });

  it("files each pair by how far apart the two projections were", () => {
    const tally = tallyOf([
      { predicted: 10, actual: 1 },
      { predicted: 9, actual: 0 },
      { predicted: 6, actual: 0 },
      { predicted: 1, actual: 0 },
    ]);

    // gaps are 1, 4, 9, 3, 8 and 5
    expect(tally.get("0-2")!.total).toBe(1);
    expect(tally.get("2-5")!.total).toBe(2);
    expect(tally.get("5+")!.total).toBe(3);
    expect(tally.get("all")!.total).toBe(6);
  });

  it("adds groups into a shared tally", () => {
    const tally = emptyTally();
    addPairs(tally, [
      { predicted: 10, actual: 9 },
      { predicted: 1, actual: 0 },
    ]);
    addPairs(tally, [
      { predicted: 10, actual: 0 },
      { predicted: 1, actual: 9 },
    ]);

    expect(tally.get("all")!.total).toBe(2);
    expect(pairRate(tally, "all")).toBe(0.5);
  });
});
