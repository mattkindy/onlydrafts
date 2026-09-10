import { describe, expect, it } from "vitest";
import { mergedTouches, type SeasonRows } from "./touchesSeasons.js";

/** three seasons of one row each, standing in for the file on disk */
function file(): SeasonRows {
  return new Map([
    [2021, ["2021,1,NE,BUF"]],
    [2022, ["2022,1,NE,BUF"]],
    [2023, ["2023,1,NE,BUF"]],
  ]);
}

describe("mergedTouches", () => {
  it("replaces the asked season and leaves the rest as they were", () => {
    const merged = mergedTouches({
      seasons: [2021, 2022, 2023],
      asked: [2023],
      onDisk: file(),
      derived: new Map([[2023, ["2023,1,KC,DEN", "2023,2,KC,DEN"]]]),
    });

    expect(merged.rows).toEqual([
      "2021,1,NE,BUF",
      "2022,1,NE,BUF",
      "2023,1,KC,DEN",
      "2023,2,KC,DEN",
    ]);
    expect(merged.kept).toEqual([]);
  });

  it("keeps what is on disk when the play file gave nothing", () => {
    const merged = mergedTouches({
      seasons: [2021, 2022, 2023],
      asked: [2023],
      onDisk: file(),
      derived: new Map([[2023, []]]),
    });

    expect(merged.rows).toEqual([
      "2021,1,NE,BUF",
      "2022,1,NE,BUF",
      "2023,1,NE,BUF",
    ]);
    expect(merged.kept).toEqual([2023]);
  });

  it("says nothing about a season it was not asked to derive", () => {
    const merged = mergedTouches({
      seasons: [2021, 2022, 2023],
      asked: [2022],
      onDisk: file(),
      derived: new Map([[2022, ["2022,4,MIA,NYJ"]]]),
    });

    expect(merged.rows).toEqual([
      "2021,1,NE,BUF",
      "2022,4,MIA,NYJ",
      "2023,1,NE,BUF",
    ]);
    expect(merged.kept).toEqual([]);
  });

  it("replaces a part-played season rather than adding to it", () => {
    const partly = new Map([[2026, ["2026,1,NE,BUF", "2026,2,NE,MIA"]]]);
    const merged = mergedTouches({
      seasons: [2026],
      asked: [2026],
      onDisk: partly,
      derived: new Map([[2026, ["2026,1,NE,BUF"]]]),
    });

    expect(merged.rows).toEqual(["2026,1,NE,BUF"]);
  });

  it("puts a season the file has never held in season order", () => {
    const merged = mergedTouches({
      seasons: [2021, 2022, 2023, 2024],
      asked: [2024],
      onDisk: file(),
      derived: new Map([[2024, ["2024,1,SF,LA"]]]),
    });

    expect(merged.rows.at(-1)).toBe("2024,1,SF,LA");
    expect(merged.rows).toHaveLength(4);
  });

  it("keeps a season the file holds that nobody asked about", () => {
    const merged = mergedTouches({
      seasons: [2021, 2022],
      asked: [2021, 2022],
      onDisk: new Map([...file(), [2020, ["2020,1,NE,BUF"]]]),
      derived: new Map([[2021, ["2021,1,KC,DEN"]], [2022, ["2022,1,KC,DEN"]]]),
    });

    expect(merged.rows).toEqual(["2021,1,KC,DEN", "2022,1,KC,DEN"]);
  });
});
