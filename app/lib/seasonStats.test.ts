import { describe, expect, it } from "vitest";
import type { Matchup, Side } from "./providers.ts";
import {
  bestLineupPoints, chanceAt, luckOf, pairKey, playoffOdds, seasonOf, weeklySpread, winShare,
} from "./seasonStats.ts";

const POS: Record<string, string> = {
  qb1: "QB", rb1: "RB", rb2: "RB", wr1: "WR", te1: "TE", rb3: "RB",
};

const side = (
  owner: string, starters: [string, string, number][], bench: [string, number][] = [],
): Side => ({
  owner,
  points: starters.reduce((sum, [, , pts]) => sum + pts, 0),
  starters: starters.map(([key, slot, points]) => ({ key, name: key, slot, points })),
  bench: bench.map(([key, points]) => ({ key, name: key, points })),
});

const game = (a: Side, b: Side): Matchup => ({ sides: [a, b] });

describe("the best lineup a roster had", () => {
  it("fills the narrow slots first and leaves the flex for the next best", () => {
    const players = [
      { points: 20, position: "RB" }, { points: 15, position: "RB" },
      { points: 12, position: "WR" }, { points: 9, position: "RB" },
      { points: 30, position: "QB" }, { points: 2, position: "TE" },
    ];

    // QB 30, RB 20 + 15, WR 12, TE 2, and the third back in the flex
    expect(bestLineupPoints(players, ["QB", "RB", "RB", "WR", "TE", "FLEX"]))
      .toBe(30 + 20 + 15 + 12 + 2 + 9);
  });

  it("leaves a slot empty when nobody fits it", () => {
    expect(bestLineupPoints([{ points: 10, position: "RB" }], ["QB", "RB"])).toBe(10);
  });
});

describe("a season off its weeks", () => {
  const slots = ["QB", "RB", "FLEX", "BN"];
  const weeks = [
    {
      week: 1,
      games: [
        game(
          side("ann", [["qb1", "QB", 20], ["rb1", "RB", 10], ["wr1", "FLEX", 5]], [["rb3", 15]]),
          side("bo", [["qb1", "QB", 18], ["rb2", "RB", 12], ["te1", "FLEX", 1]]),
        ),
        game(
          side("cy", [["qb1", "QB", 40]]),
          side("di", [["qb1", "QB", 10]]),
        ),
      ],
    },
  ];
  const season = seasonOf(weeks, slots, (key) => POS[key]);
  const of = (owner: string) => season.find((t) => t.owner === owner)!;

  it("counts the record and the points either way", () => {
    expect([of("ann").wins, of("ann").losses, of("ann").pf, of("ann").pa])
      .toEqual([1, 0, 35, 31]);
    expect(of("bo").losses).toBe(1);
  });

  it("plays every team against every other for the all-play record", () => {
    // 35 beats 31 and 10 and loses to 40; 31 beats only 10
    expect([of("ann").allWins, of("ann").allLosses]).toEqual([2, 1]);
    expect([of("bo").allWins, of("bo").allLosses]).toEqual([1, 2]);
    expect(winShare(2, 1, 0)).toBeCloseTo(2 / 3);
  });

  it("measures the lineup against the best the roster could have started", () => {
    // the bench back's 15 belonged in the flex over the receiver's 5
    expect(of("ann").started).toBe(35);
    expect(of("ann").best).toBe(45);
  });

  it("says how many wins a team's luck is worth", () => {
    // ann won her game while scoring like a team that wins two in three,
    // and bo lost his scoring like one that wins one in three
    expect(luckOf(of("ann"))).toBeCloseTo(1 - 2 / 3);
    expect(luckOf(of("bo"))).toBeCloseTo(-1 / 3);
  });
});

describe("the spread of a team's weeks", () => {
  it("falls back to a quarter of the mean before the season can say", () => {
    expect(weeklySpread([], 100)).toBe(25);
  });
});

describe("the rest of the season played out", () => {
  const table = ["ann", "bo", "cy", "di"].map((owner) => ({
    owner, wins: 4, ties: 0, pf: 400,
  }));
  const weeks: [string, string][][] = Array.from({ length: 5 }, () => [
    ["ann", "bo"], ["cy", "di"],
  ]);
  const even = new Map(["ann", "bo", "cy", "di"].map((o) => [o, { mean: 100, sd: 25 }]));

  it("sends a far stronger team through almost every time", () => {
    const strength = new Map(even);

    strength.set("ann", { mean: 160, sd: 25 });

    const run = playoffOdds({ table, weeks, strength, playoffTeams: 2, draws: 2000 });
    const ann = run.odds.find((o) => o.owner === "ann")!;

    expect(ann.playoffs).toBeGreaterThan(0.97);
    expect(ann.wins).toBeGreaterThan(8.5);
  });

  it("hands out exactly the playoff places there are", () => {
    const run = playoffOdds({ table, weeks, strength: even, playoffTeams: 2, draws: 2000 });
    const total = run.odds.reduce((sum, o) => sum + o.playoffs, 0);

    expect(total).toBeCloseTo(2, 5);
  });

  it("says what this week's game is worth to you", () => {
    const run = playoffOdds({
      table, weeks, strength: even, playoffTeams: 2, draws: 4000, mine: "ann",
      thisWeek: [{ a: "ann", b: "bo", odds: 0.5, projected: [100, 100] }],
    });

    expect(run.ifWin!).toBeGreaterThan(run.ifLose!);
  });

  it("plays a picked result the way it was picked", () => {
    // ann loses every remaining game, cy wins every one
    const forced = new Map(weeks.flatMap((_, w) => [
      [pairKey(w, "ann", "bo"), "bo"], [pairKey(w, "di", "cy"), "cy"],
    ]));
    const run = playoffOdds({ table, weeks, strength: even, playoffTeams: 2, forced, draws: 500 });
    const of = (owner: string) => run.odds.find((o) => o.owner === owner)!;

    expect(of("ann").wins).toBe(4);
    expect(of("cy").wins).toBe(9);
    expect([of("bo").playoffs, of("cy").playoffs]).toEqual([1, 1]);
  });

  it("follows your record week by week, and averages back to your chance", () => {
    const run = playoffOdds({
      table, weeks, strength: even, playoffTeams: 2, draws: 3000, mine: "ann",
    });
    const now = run.odds.find((o) => o.owner === "ann")!.playoffs;

    expect(run.path).toHaveLength(weeks.length);
    run.path.forEach((week, w) => {
      expect(week.every((o) => o.played === w + 1)).toBe(true);
      expect(week.reduce((sum, o) => sum + o.share, 0)).toBeCloseTo(1, 9);
      // however the seasons are split, the split averages to the whole
      expect(week.reduce((sum, o) => sum + o.share * o.playoffs, 0)).toBeCloseTo(now, 9);
    });

    const last = run.path[weeks.length - 1]!;
    const most = last.find((o) => o.won === 5)!;
    const fewest = last.find((o) => o.won === 0)!;

    expect(most.playoffs).toBeGreaterThan(fewest.playoffs);
  });

  it("keeps only the record a pick leaves you", () => {
    const forced = new Map([[pairKey(0, "ann", "bo"), "ann"]]);
    const run = playoffOdds({
      table, weeks, strength: even, playoffTeams: 2, forced, draws: 500, mine: "ann",
    });

    expect(run.path[0]!.map((o) => [o.won, o.share])).toEqual([[1, 1]]);
  });

  it("has no path without a team of yours", () => {
    expect(playoffOdds({ table, weeks, strength: even, playoffTeams: 2, draws: 50 }).path)
      .toEqual([]);
  });

  it("reads a share of seasons off the ways a week can go", () => {
    const ways = [
      { won: 0, played: 1, share: 0.5, playoffs: 0.4 },
      { won: 1, played: 1, share: 0.5, playoffs: 0.7 },
    ];

    expect(chanceAt(ways, 0.5)).toBeCloseTo(0.55, 9);
    expect(chanceAt(ways, 0.1)).toBe(0.4);
    expect(chanceAt(ways, 0.9)).toBe(0.7);
    expect(chanceAt([{ won: 2, played: 2, share: 1, playoffs: 0.9 }], 0.5)).toBe(0.9);
    expect(chanceAt([], 0.5)).toBe(0);
  });

  it("gives the same answer twice", () => {
    const once = playoffOdds({ table, weeks, strength: even, playoffTeams: 2, draws: 500 });
    const again = playoffOdds({ table, weeks, strength: even, playoffTeams: 2, draws: 500 });

    expect(once).toEqual(again);
  });
});
