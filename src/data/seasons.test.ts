import { describe, expect, it } from "vitest";
import { parseSeasonList, seasonsAsked } from "./seasons.js";

describe("parseSeasonList", () => {
  it("falls back when nobody says", () => {
    expect(parseSeasonList(undefined, [2024, 2025])).toEqual([2024, 2025]);
  });

  it("reads a range end to end", () => {
    expect(parseSeasonList("2021-2024", [])).toEqual([2021, 2022, 2023, 2024]);
  });

  it("reads a comma list", () => {
    expect(parseSeasonList("2021,2026", [])).toEqual([2021, 2026]);
  });
});

describe("seasonsAsked", () => {
  it("takes the value after the flag", () => {
    expect(seasonsAsked(["node", "x.ts", "--seasons", "2026"], [2021]))
      .toEqual([2026]);
  });

  it("falls back when the flag is absent", () => {
    expect(seasonsAsked(["node", "x.ts", "--force"], [2021])).toEqual([2021]);
  });
});
