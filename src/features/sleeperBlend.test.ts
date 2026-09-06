import { describe, expect, it } from "vitest";
import { blendPoints, fitBlendWeight, type BlendEntry } from "./sleeperBlend.js";

describe("blendPoints", () => {
  it("keeps ours at weight zero and theirs at weight one", () => {
    expect(blendPoints(10, 20, 0)).toBe(10);
    expect(blendPoints(10, 20, 1)).toBe(20);
  });

  it("averages the two at half", () => {
    expect(blendPoints(10, 20, 0.5)).toBe(15);
  });
});

/** one slate where sleeper ranks the men correctly and ours does not */
const sleeperIsRight: BlendEntry[] = [
  { ours: 20, sleeper: 5, actual: 5 },
  { ours: 5, sleeper: 20, actual: 25 },
];

const oursIsRight: BlendEntry[] = [
  { ours: 20, sleeper: 5, actual: 25 },
  { ours: 5, sleeper: 20, actual: 5 },
];

describe("fitBlendWeight", () => {
  it("leans on sleeper when only sleeper gets the calls right", () => {
    const weight = fitBlendWeight([sleeperIsRight]);
    expect(weight).toBeGreaterThan(0.5);
    expect(blendPoints(20, 5, weight)).toBeLessThan(blendPoints(5, 20, weight));
  });

  it("keeps everything on ours when only ours gets the calls right", () => {
    expect(fitBlendWeight([oursIsRight])).toBe(0);
  });

  it("takes the smaller weight when the two are tied", () => {
    expect(fitBlendWeight([sleeperIsRight, oursIsRight])).toBe(0);
  });

  it("counts every slate it is given", () => {
    const weight = fitBlendWeight([sleeperIsRight, sleeperIsRight, oursIsRight]);
    expect(weight).toBeGreaterThan(0.5);
  });
});
