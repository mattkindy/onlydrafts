import { describe, expect, it } from "vitest";
import { layoutPlayoffs, layoutSeasonTable } from "./shareStats.ts";

describe("the playoff picture", () => {
  const picture = layoutPlayoffs({
    league: "Test League",
    week: 9,
    playoffTeams: 2,
    teams: [
      { name: "low", record: "1-7", wins: 3, odds: 0.004, mine: false },
      { name: "top", record: "7-1", wins: 11, odds: 0.996, mine: false },
      { name: "me", record: "4-4", wins: 7, odds: 0.5, mine: true },
    ],
  });

  it("lists the teams by their chance, best first", () => {
    expect(picture.rows.map((r) => r.name)).toEqual(["top", "me", "low"]);
  });

  it("keeps the tenths at the ends, where a whole number would say it is settled", () => {
    expect(picture.rows.map((r) => r.odds)).toEqual(["99.6%", "50%", "0.4%"]);
  });

  it("draws the line under the last playoff place", () => {
    expect(picture.cut).toBe(picture.rows[2]!.y);
    expect(picture.subtitle).toBe("playoff chances, week 9");
  });
});

describe("the season table picture", () => {
  it("writes each team's row in the column order of its headings", () => {
    const picture = layoutSeasonTable({
      league: "Test League",
      week: 8,
      teams: [{
        name: "me", record: "4-4", pf: 1006.62, pa: 1030.2, allPlay: 0.61,
        luck: -0.94, efficiency: 0.912, mine: true,
      }],
    });

    expect(picture.heads.length).toBe(picture.rows[0]!.cells.length);
    expect(picture.rows[0]!.cells).toEqual(
      ["me", "4-4", "1006.6", "1030.2", "61%", "-0.9", "91%"]);
  });
});
