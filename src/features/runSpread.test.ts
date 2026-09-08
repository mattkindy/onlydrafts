import { describe, expect, it } from "vitest";
import { quantileOf, spreadOf } from "./runSpread.js";

const ramp = Array.from({ length: 41 }, (_, i) => i);

describe("what a man's dealt games looked like", () => {
  it("reads the percentiles off the sorted runs", () => {
    const his = spreadOf([...ramp].reverse());

    expect(his.p10).toBe(4);
    expect(his.p25).toBe(10);
    expect(his.p50).toBe(20);
    expect(his.p75).toBe(30);
    expect(his.p90).toBe(36);
  });

  it("counts the runs that cleared a line", () => {
    const his = spreadOf(ramp);

    expect(his.runs).toBe(41);
    // 21 through 40 clear twenty, 31 through 40 clear thirty
    expect(his.over20).toBeCloseTo(20 / 41, 6);
    expect(his.over30).toBeCloseTo(10 / 41, 6);
  });

  it("has no spread when every run scored the same", () => {
    const his = spreadOf([9, 9, 9, 9]);

    expect(his.sd).toBe(0);
    expect(his.p10).toBe(9);
    expect(his.p90).toBe(9);
  });

  it("measures the spread around the mean", () => {
    expect(spreadOf([0, 10]).sd).toBe(5);
  });

  it("says nothing about a man nobody dealt", () => {
    const his = spreadOf([]);

    expect(his.runs).toBe(0);
    expect(his.p90).toBe(0);
    expect(quantileOf([], 0.9)).toBe(0);
  });
});
