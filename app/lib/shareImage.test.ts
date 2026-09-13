import { describe, expect, it } from "vitest";

import {
  fileNameFor, layoutGame, layoutWeek, pctText, textOf, WIDTH,
  type ShareGame,
} from "./shareImage.ts";

function game(
  home: [string, number, number, number], away: [string, number, number, number],
  owners?: [string, string],
): ShareGame {
  return {
    sides: [
      {
        name: home[0], points: home[1], projected: home[2], odds: home[3],
        ...(owners ? { owner: owners[0] } : {}),
      },
      {
        name: away[0], points: away[1], projected: away[2], odds: away[3],
        ...(owners ? { owner: owners[1] } : {}),
      },
    ],
  };
}

const week = {
  league: "Dynasty Warriors",
  week: 3,
  games: [
    game(["Team Rocket", 88.4, 120.25, 0.63], ["Gronk Life", 72, 110.4, 0.37]),
    game(["Sunday Scaries", 0, 99.9, 0.5], ["Bye Week", 0, 99.9, 0.5]),
  ],
};

describe("layoutWeek", () => {
  it("stacks the cards down the page without overlapping", () => {
    const layout = layoutWeek(week);

    expect(layout.width).toBe(WIDTH);
    expect(layout.cards).toHaveLength(2);

    const [first, second] = layout.cards;

    expect(second!.y).toBeGreaterThan(first!.y + first!.height);
    expect(layout.height).toBeGreaterThan(second!.y + second!.height);
  });

  it("marks the favoured side and leaves a tie unmarked", () => {
    const [close, tied] = layoutWeek(week).cards;

    expect(close!.sides.map((s) => s.favoured)).toEqual([true, false]);
    expect(tied!.sides.map((s) => s.favoured)).toEqual([false, false]);
  });

  it("fills the bar with the left side's chance", () => {
    expect(layoutWeek(week).cards[0]!.fill).toBeCloseTo(0.63);
  });

  it("says the league, the week, the points, the odds, and the site", () => {
    const said = textOf(layoutWeek(week));

    expect(said[0]).toBe("Dynasty Warriors");
    expect(said[1]).toBe("week 3");
    expect(said).toContain("Team Rocket");
    expect(said).toContain("88.4");
    expect(said).toContain("120.3 proj");
    expect(said).toContain("63%");
    expect(said.at(-1)).toBe("onlydrafts");
  });

  it("leaves room for the owners when the league gives them", () => {
    const withOwners = layoutWeek({
      ...week,
      games: [game(
        ["Team Rocket", 88.4, 120.25, 0.63],
        ["Gronk Life", 72, 110.4, 0.37],
        ["matt", "dave"],
      )],
    });

    expect(withOwners.cards[0]!.height)
      .toBeGreaterThan(layoutWeek(week).cards[0]!.height);
    expect(textOf(withOwners)).toContain("matt");
  });

  it("leaves the owner out when it is the team name again", () => {
    const same = layoutWeek({
      ...week,
      games: [game(
        ["matt", 1, 2, 0.5], ["dave", 1, 2, 0.5], ["matt", "dave"])],
    });

    expect(same.cards[0]!.sides[0]!.owner).toBe(null);
  });

  it("gives an empty week a header and a footer and no cards", () => {
    const empty = layoutWeek({ league: "Dynasty Warriors", week: 3, games: [] });

    expect(empty.cards).toEqual([]);
    expect(empty.height).toBeGreaterThan(0);
  });
});

describe("layoutGame", () => {
  it("lays out one card the same way the week does", () => {
    const one = layoutGame("Dynasty Warriors", 3, week.games[0]!);

    expect(one.cards).toHaveLength(1);
    expect(one.cards[0]).toEqual(layoutWeek(week).cards[0]);
  });
});

describe("pctText", () => {
  it("rounds to whole points", () => {
    expect(pctText(0.634)).toBe("63%");
    expect(pctText(1)).toBe("100%");
    expect(pctText(0)).toBe("0%");
  });
});

describe("fileNameFor", () => {
  it("names the file after the site and the week", () => {
    expect(fileNameFor(layoutWeek(week))).toBe("onlydrafts-week-3.png");
  });
});
