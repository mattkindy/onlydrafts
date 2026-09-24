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

  it("lists a rebuilt week once", () => {
    const withOld = { ...live, weeks: [{ season: 2025, week: 10 }, ...live.weeks] };
    const merged = mergeSiteIndex(withOld, {
      weeks: [{ season: 2025, week: 10 }], boardSeason: 2025, adpFormat: "ppr",
    });

    expect(merged.weeks).toEqual([
      { season: 2025, week: 10 },
      { season: 2026, week: 3 },
    ]);
  });

  it("keeps the weeks already played when the next one is built", () => {
    const played: SiteIndex = {
      ...live, weeks: [{ season: 2026, week: 1 }, { season: 2026, week: 2 }],
    };
    const merged = mergeSiteIndex(played, {
      weeks: [{ season: 2026, week: 3 }], boardSeason: 2026, adpFormat: "standard",
    });

    expect(merged.weeks).toEqual([
      { season: 2026, week: 1 },
      { season: 2026, week: 2 },
      { season: 2026, week: 3 },
    ]);
    expect(merged.adpFormat).toBe("standard");
  });

  it("starts the list again for a newer season", () => {
    const next: SiteIndex = {
      weeks: [{ season: 2027, week: 1 }], boardSeason: 2027, adpFormat: "ppr",
    };

    expect(mergeSiteIndex(live, next)).toEqual(next);
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
