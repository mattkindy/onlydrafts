import { describe, expect, it } from "vitest";

import { pct } from "./Advice.tsx";

describe("pct", () => {
  it("rounds to a whole percent in the middle", () => {
    expect(pct(0.843)).toBe("84%");
    expect(pct(0.5)).toBe("50%");
  });

  it("keeps a tenth when a game is nearly settled", () => {
    expect(pct(0.994)).toBe("99.4%");
    expect(pct(0.003)).toBe("0.3%");
  });

  it("rounds the tenth toward the middle, so only a settled game says 100 or 0", () => {
    expect(pct(0.9997)).toBe("99.9%");
    expect(pct(0.0002)).toBe("0.1%");
    expect(pct(1)).toBe("100%");
    expect(pct(0)).toBe("0%");
  });

  it("says the same tenth from either side of the same game", () => {
    expect(pct(0.999)).toBe("99.9%");
    expect(pct(1 - 0.999)).toBe("0.1%");
    expect(pct(0.9985)).toBe("99.8%");
    expect(pct(1 - 0.9985)).toBe("0.2%");
  });
});
