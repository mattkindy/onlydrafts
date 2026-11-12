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

  it("draws no bye or title where the bracket was not played out", () => {
    expect(picture.hasTitle).toBe(false);
    expect(picture.rows[0]!.title).toBeNull();
  });
});

describe("the playoff picture with the bracket played out", () => {
  const picture = layoutPlayoffs({
    league: "Test League",
    week: 9,
    playoffTeams: 2,
    whatIf: "2 picks",
    teams: [
      { name: "top", record: "7-1", wins: 11, odds: 0.99, bye: 0.8, champion: 0.4, division: 0.9, mine: false },
      { name: "me", record: "4-4", wins: 7, odds: 0.5, bye: 0.1, champion: 0.08, division: 0.1, mine: true },
    ],
  });

  it("carries the bye, the title and the division, as the page does", () => {
    expect(picture.hasBye && picture.hasTitle).toBe(true);
    expect(picture.rows.map((r) => [r.bye, r.title, r.division]))
      .toEqual([["80%", "40%", "90%"], ["10%", "8%", "10%"]]);
  });

  it("says a what-if is one", () => {
    expect(picture.subtitle).toBe("what if 2 picks, week 9");
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
