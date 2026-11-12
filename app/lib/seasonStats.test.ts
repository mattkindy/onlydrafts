import { describe, expect, it } from "vitest";
import type { Tiebreak } from "./playoffRules.ts";
import type { Matchup, Side } from "./providers.ts";
import {
  bestLineupPoints, bracketSlots, chanceAt, chanceOf, luckOf, pairKey, playoffOdds,
  playoffRounds, scenarioPath, TIE, type SeedRow, seasonOf, type Strength, weeklySpread, winShare,
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

  it("splits a picked tie, half a win to each side", () => {
    const forced = new Map(weeks.flatMap((_, w) => [
      [pairKey(w, "ann", "bo"), TIE], [pairKey(w, "cy", "di"), "cy"],
    ]));
    const run = playoffOdds({
      table, weeks, strength: even, playoffTeams: 2, forced, draws: 200, mine: "ann",
    });
    const of = (owner: string) => run.odds.find((o) => o.owner === owner)!;

    expect(of("ann").wins).toBe(6.5);
    expect(of("bo").wins).toBe(6.5);
    expect(of("cy").wins).toBe(9);
    // a tie this week is neither the win nor the loss the tile prices
    expect([run.ifWin, run.ifLose]).toEqual([null, null]);
    expect(run.path[2]!.map((o) => [o.won, o.tied, o.played])).toEqual([[0, 3, 3]]);
  });

  it("has no path without a team of yours", () => {
    expect(playoffOdds({ table, weeks, strength: even, playoffTeams: 2, draws: 50 }).path)
      .toEqual([]);
  });

  it("reads a share of seasons off the ways a week can go", () => {
    const ways = [
      { won: 0, tied: 0, played: 1, share: 0.5, playoffs: 0.4 },
      { won: 1, tied: 0, played: 1, share: 0.5, playoffs: 0.7 },
    ];

    expect(chanceAt(ways, 0.5)).toBeCloseTo(0.55, 9);
    expect(chanceAt(ways, 0.1)).toBe(0.4);
    expect(chanceAt(ways, 0.9)).toBe(0.7);
    expect(chanceAt([{ won: 2, tied: 0, played: 2, share: 1, playoffs: 0.9 }], 0.5)).toBe(0.9);
    expect(chanceAt([], 0.5)).toBe(0);
  });

  it("moves the path in the week a picked result happens, not before", () => {
    const meanOf = chanceOf;
    const playOut = (picks: Map<string, string>) => playoffOdds({
      table, weeks, strength: even, playoffTeams: 2, forced: picks, draws: 2000, mine: "ann",
    });
    const plays: number[] = [];
    const counted = (picks: Map<string, string>) => {
      plays.push(picks.size);
      return playOut(picks);
    };

    const won = scenarioPath({
      forced: new Map([[pairKey(2, "ann", "bo"), "ann"]]),
      weeks: 5, mine: "ann", playOut: counted,
    });
    const lost = scenarioPath({
      forced: new Map([[pairKey(2, "ann", "bo"), "bo"]]),
      weeks: 5, mine: "ann", playOut,
    });
    const none = playOut(new Map()).odds.find((o) => o.owner === "ann")!.playoffs;

    // today is today, whatever is picked for later
    expect(won.now).toBe(none);
    expect(lost.now).toBe(none);
    // the first two weeks know nothing of the pick, so they agree
    expect(meanOf(won.cols[1]!)).toBeCloseTo(meanOf(lost.cols[1]!), 9);
    // and the picked week splits them
    expect(meanOf(won.cols[2]!)).toBeGreaterThan(meanOf(won.cols[1]!) + 0.05);
    expect(meanOf(lost.cols[2]!)).toBeLessThan(meanOf(lost.cols[1]!) - 0.05);
    // one run before the pick and one from it on
    expect(plays).toEqual([0, 1]);
    // and the last week's chance is the chance with the pick
    const picked = playOut(new Map([[pairKey(2, "ann", "bo"), "ann"]]));

    expect(chanceOf(won.cols[4]!)).toBeCloseTo(
      picked.odds.find((o) => o.owner === "ann")!.playoffs, 9);

    // and with the runs kept, a later pick plays only the weeks it changes
    const runs = new Map();
    const picks = new Map([[pairKey(2, "ann", "bo"), "ann"]]);

    plays.length = 0;
    scenarioPath({ forced: picks, weeks: 5, mine: "ann", playOut: counted, runs });
    picks.set(pairKey(4, "ann", "bo"), "bo");
    scenarioPath({ forced: picks, weeks: 5, mine: "ann", playOut: counted, runs });
    expect(plays).toEqual([0, 1, 2]);
  });

  it("gives the same answer twice", () => {
    const once = playoffOdds({ table, weeks, strength: even, playoffTeams: 2, draws: 500 });
    const again = playoffOdds({ table, weeks, strength: even, playoffTeams: 2, draws: 500 });

    expect(once).toEqual(again);
  });
});

describe("a league's own playoff rules", () => {
  const row = (owner: string, wins: number, pf: number, extra: Partial<SeedRow> = {}): SeedRow =>
    ({ owner, wins, ties: 0, pf, ...extra });
  const flat = new Map(["ann", "bo", "cy", "di"].map((o) => [o, { mean: 100, sd: 25 }]));
  const chance = (run: ReturnType<typeof playoffOdds>, owner: string) =>
    run.odds.find((o) => o.owner === owner)!;

  it("lets each division's winner in, and the best of the rest after", () => {
    const divisionOf = new Map([["ann", 1], ["bo", 1], ["cy", 2], ["di", 2]]);
    const weeks: [string, string][][] = Array.from({ length: 4 }, () => [["ann", "cy"], ["bo", "di"]]);
    const table = ["ann", "bo", "cy", "di"].map((o) => row(o, 3, 300));
    const run = playoffOdds({
      table, weeks, strength: flat, playoffTeams: 3, draws: 2000, divisionOf,
      rules: { seedBy: "wins", ties: ["pf"], divisions: true },
    });

    // one title in each division every season
    expect(chance(run, "ann").division! + chance(run, "bo").division!).toBeCloseTo(1, 9);
    expect(chance(run, "cy").division! + chance(run, "di").division!).toBeCloseTo(1, 9);
    expect(run.odds.reduce((sum, o) => sum + o.playoffs, 0)).toBeCloseTo(3, 9);
  });

  it("puts a weak division's winner in over a better team elsewhere", () => {
    const divisionOf = new Map([["ann", 1], ["bo", 1], ["cy", 1], ["di", 2]]);
    const table = [row("ann", 9, 900), row("bo", 8, 800), row("cy", 7, 700), row("di", 2, 200)];
    const rules = { seedBy: "wins" as const, ties: ["pf" as const], divisions: true };
    const run = playoffOdds({ table, weeks: [], strength: flat, playoffTeams: 2, draws: 10, divisionOf, rules });

    expect(chance(run, "di").playoffs).toBe(1);
    expect(chance(run, "bo").playoffs).toBe(0);
  });

  it("ranks by points for, or by record with the median games, when the league does", () => {
    const table = [
      row("ann", 6, 800, { medianWins: 2 }),
      row("bo", 4, 1000, { medianWins: 5 }),
    ];
    const by = (seedBy: "wins" | "median" | "pf") => chance(playoffOdds({
      table, weeks: [], strength: flat, playoffTeams: 1, draws: 10,
      rules: { seedBy, ties: [], divisions: false },
    }), "ann").playoffs;

    expect(by("wins")).toBe(1);
    expect(by("pf")).toBe(0);
    expect(by("median")).toBe(0);
  });

  it("settles a tie head-to-head before points for when asked to", () => {
    const table = [
      row("ann", 5, 800, { versus: { bo: { won: 2, games: 2 } } }),
      row("bo", 5, 900, { versus: { ann: { won: 0, games: 2 } } }),
    ];
    const first = (ties: Tiebreak[]) => chance(playoffOdds({
      table, weeks: [], strength: flat, playoffTeams: 1, draws: 10,
      rules: { seedBy: "wins", ties, divisions: false },
    }), "ann").playoffs;

    expect(first(["h2h", "pf"])).toBe(1);
    expect(first(["pf"])).toBe(0);
    expect(first(["paFewest", "pf"])).toBe(0);
  });

  it("flips a coin for two teams nothing can split", () => {
    const table = [row("ann", 5, 800), row("bo", 5, 800)];
    const run = playoffOdds({
      table, weeks: [], strength: flat, playoffTeams: 1, draws: 4000,
      rules: { seedBy: "wins", ties: ["pf"], divisions: false },
    });

    expect(chance(run, "ann").playoffs).toBeGreaterThan(0.45);
    expect(chance(run, "ann").playoffs).toBeLessThan(0.55);
  });

  it("keeps each week's median wins and each pairing's record from the weeks played", () => {
    const team = (owner: string, points: number) => ({ owner, points, starters: [], bench: [] });
    const seasons = seasonOf([{
      week: 1,
      games: [
        { sides: [team("ann", 120), team("bo", 90)] },
        { sides: [team("cy", 100), team("di", 80)] },
      ] as unknown as Matchup[],
    }], null, () => undefined);
    const of = (owner: string) => seasons.find((t) => t.owner === owner)!;

    // the median of 120, 100, 90 and 80 is 95
    expect([of("ann"), of("bo"), of("cy"), of("di")].map((t) => t.medianWins)).toEqual([1, 0, 1, 0]);
    expect(of("ann").versus).toEqual({ bo: { won: 1, games: 1 } });
    expect(of("bo").versus).toEqual({ ann: { won: 0, games: 1 } });
  });
});

describe("the playoffs played out after the season", () => {
  const owners = ["ann", "bo", "cy", "di", "ed", "fy"];
  // the table already settled: ann first down to fy last, two weeks left
  const table = owners.map((owner, i) => ({ owner, wins: 10 - 2 * i, ties: 0, pf: 1000 - i }));
  const weeks: [string, string][][] = Array.from({ length: 2 }, () => [
    ["ann", "fy"], ["bo", "ed"], ["cy", "di"],
  ]);
  const even = new Map(owners.map((o) => [o, { mean: 100, sd: 20 }]));

  it("takes a round a week, a short field's top seeds sitting the first out", () => {
    expect(playoffRounds(6)).toBe(3);
    expect(playoffRounds(4)).toBe(2);
    expect(playoffRounds(8)).toBe(3);
    expect(bracketSlots(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });

  it("crowns one team a season, and only teams that made it", () => {
    const run = playoffOdds({
      table, weeks, strength: even, bracket: [even, even, even], playoffTeams: 4, draws: 3000,
    });
    const total = run.odds.reduce((sum, o) => sum + (o.champion ?? 0), 0);

    expect(total).toBeCloseTo(1, 5);
    // fy is four games behind the last place in with two to play
    expect(run.odds.find((o) => o.owner === "fy")!.champion).toBe(0);
  });

  it("counts a team at its playoff strength, not its strength now", () => {
    // di is ordinary through the season and back to full strength in December
    const december = new Map(even);

    december.set("di", { mean: 150, sd: 20 });

    const run = playoffOdds({
      table, weeks, strength: even, bracket: [december, december, december],
      playoffTeams: 4, draws: 3000,
    });
    const plain = playoffOdds({
      table, weeks, strength: even, bracket: [even, even, even], playoffTeams: 4, draws: 3000,
    });
    const di = (r: typeof run) => r.odds.find((o) => o.owner === "di")!;

    expect(di(run).playoffs).toBeCloseTo(di(plain).playoffs, 5);
    expect(di(run).champion!).toBeGreaterThan(di(plain).champion! + 0.3);
  });

  it("gives a bye to the top seeds of a short field", () => {
    // with six in, ann and bo play two games to the title where the rest play three
    const run = playoffOdds({
      table: table.map((t) => ({ ...t, wins: 10 })), weeks: [],
      strength: even, bracket: [even, even, even], playoffTeams: 6, draws: 4000,
    });
    const ann = run.odds.find((o) => o.owner === "ann")!.champion!;
    const fy = run.odds.find((o) => o.owner === "fy")!.champion!;

    // a coin flip a game: a quarter for a bye, an eighth without one
    expect(ann).toBeCloseTo(0.25, 1);
    expect(fy).toBeCloseTo(0.125, 1);
    // a field of six hands out two byes a season
    expect(run.odds.reduce((sum, o) => sum + (o.bye ?? 0), 0)).toBeCloseTo(2, 5);
  });

  it("draws each week from that week's strengths", () => {
    // bo is out the first week and ann wins it; the second week they are level
    const hurt: Map<string, Strength> = new Map(even);

    hurt.set("bo", { mean: 10, sd: 5 });

    const run = playoffOdds({
      table: owners.map((owner) => ({ owner, wins: 0, ties: 0, pf: 0 })),
      weeks: [[["ann", "bo"]], [["ann", "bo"]]], strength: even, byWeek: [hurt, even],
      playoffTeams: 1, draws: 3000,
    });

    expect(run.odds.find((o) => o.owner === "ann")!.wins).toBeCloseTo(1.5, 1);
  });
});
