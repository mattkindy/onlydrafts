import { describe, expect, it } from "vitest";
import {
  emptyStatLine,
  fantasyPoints,
  presets,
  scoringRules,
} from "./fantasyPoints.js";

describe("fantasyPoints", () => {
  it("scores a receiving line differently per preset", () => {
    const line = { ...emptyStatLine(), receptions: 8, recYds: 100, recTd: 1 };

    expect(fantasyPoints(line, presets.standard)).toBe(16);
    expect(fantasyPoints(line, presets.half)).toBe(20);
    expect(fantasyPoints(line, presets.ppr)).toBe(24);
  });

  it("scores a passing line with turnovers", () => {
    const line = {
      ...emptyStatLine(),
      passYds: 300,
      passTd: 2,
      interceptions: 1,
    };

    expect(fantasyPoints(line, presets.ppr)).toBe(18);
  });

  it("applies overrides for custom league rules", () => {
    const sixPointPassing = scoringRules("ppr", { passTd: 6 });
    const line = { ...emptyStatLine(), passTd: 2 };

    expect(fantasyPoints(line, sixPointPassing)).toBe(12);
    expect(fantasyPoints(line, presets.ppr)).toBe(8);
  });

  it("scores an empty line as zero", () => {
    expect(fantasyPoints(emptyStatLine(), presets.ppr)).toBe(0);
  });
});
