import { describe, expect, it } from "vitest";
import { mergeSiteIndex, parseSiteIndex, type SiteIndex } from "./siteIndex.js";

const live: SiteIndex = {
  weeks: [{ season: 2026, week: 3 }],
  boardSeason: 2026,
  adpFormat: "ppr",
};

describe("mergeSiteIndex", () => {
  it("keeps the live board when an older season is rebuilt", () => {
    const merged = mergeSiteIndex(live, {
      weeks: [{ season: 2025, week: 10 }],
      boardSeason: 2025,
      adpFormat: "standard",
    });

    expect(merged.boardSeason).toBe(2026);
    expect(merged.adpFormat).toBe("ppr");
    expect(merged.weeks).toEqual([
      { season: 2025, week: 10 },
      { season: 2026, week: 3 },
    ]);
  });

  it("replaces the older season's weeks rather than listing them twice", () => {
    const withOld = { ...live, weeks: [{ season: 2025, week: 9 }, ...live.weeks] };
    const merged = mergeSiteIndex(withOld, {
      weeks: [{ season: 2025, week: 10 }], boardSeason: 2025, adpFormat: "ppr",
    });

    expect(merged.weeks).toEqual([
      { season: 2025, week: 10 },
      { season: 2026, week: 3 },
    ]);
  });

  it("writes the build as it is for the same season or a newer one", () => {
    const next: SiteIndex = {
      weeks: [{ season: 2026, week: 4 }], boardSeason: 2026, adpFormat: "ppr",
    };

    expect(mergeSiteIndex(live, next)).toEqual(next);
    expect(mergeSiteIndex(live, { ...next, boardSeason: 2027 }).boardSeason)
      .toBe(2027);
    expect(mergeSiteIndex(undefined, next)).toEqual(next);
  });
});

describe("parseSiteIndex", () => {
  it("reads a bare week number as a week of the board season", () => {
    expect(parseSiteIndex('{"weeks":[3],"boardSeason":2026}')).toEqual({
      weeks: [{ season: 2026, week: 3 }], boardSeason: 2026, adpFormat: "ppr",
    });
  });

  it("reads the index the build writes", () => {
    expect(parseSiteIndex(JSON.stringify(live))).toEqual(live);
  });
});
