import { describe, expect, it } from "vitest";
import { impliedFor, NEUTRAL_TOTAL, sizeOf } from "./gameSize.js";

describe("how big an afternoon is", () => {
  it("splits the total by the line", () => {
    // a 47 point game with a three point favourite: 25 and 22
    expect(impliedFor({ total: 47, favouredBy: 3 })).toBe(25);
    expect(impliedFor({ total: 47, favouredBy: -3 })).toBe(22);
  });

  it("leaves an ordinary game alone", () => {
    expect(sizeOf({ total: NEUTRAL_TOTAL, favouredBy: 0 })).toBe(1);
  });

  it("lifts a shootout and cuts a slog", () => {
    const shootout = sizeOf({ total: 54, favouredBy: 6 });
    const slog = sizeOf({ total: 37, favouredBy: -6 });

    expect(shootout).toBeGreaterThan(1.2);
    expect(slog).toBeLessThan(0.75);
  });

  it("will not zero out a team nobody fancies", () => {
    expect(sizeOf({ total: 30, favouredBy: -14 })).toBeGreaterThanOrEqual(0.6);
  });
});
