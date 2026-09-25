import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  alternativesFor, bestLineupFor, clockLeftOf, fractionLeft, hasLineup,
  hurtFrom, initialForm, liveDraws, myGameIn, nextKickoffFrom, outscoreShare,
  oddsFor, standingFor, sideTotals, situationsFrom, spreadOf, starterState,
  statesFrom, stockLine,
} from "./matchups.ts";
import type { GameState, InGameStatus } from "./matchups.ts";
import type { Matchup, Side } from "./providers.ts";
import type { SlateRow } from "./slate.ts";
import { weeksFromSpread } from "./spread.ts";

const row = (
  name: string, team: string, blend: number,
  position = "WR", opponent = "NE",
): SlateRow => ({
  playerId: name,
  name,
  position,
  team,
  opponent,
  home: true,
  ours: blend,
  sleeper: blend,
  blend,
  floor: blend * 0.4,
  ceiling: blend * 1.8,
  catches: 0,
  questionable: false,
  ruledOut: false,
  gamesMissedRecent: 0,
  absenceShare: 0,
});

const rowsFor = (...rows: SlateRow[]) =>
  new Map(rows.map((r) => [r.name, r]));

const side = (
  owner: string, points: number, starters: Side["starters"],
): Side => ({ owner, points, starters, bench: [] });

const states = (of: Record<string, GameState>) =>
  new Map(Object.entries(of));

describe("oddsFor", () => {
  it("gives a side that is ahead with every game over the whole thing", () => {
    const rows = rowsFor(row("ahead", "BUF", 12), row("behind", "MIA", 12));
    const matchup: Matchup = {
      sides: [
        side("me", 100, [{ key: "ahead", slot: "WR", points: 100 }]),
        side("you", 80, [{ key: "behind", slot: "WR", points: 80 }]),
      ],
    };
    const [mine, theirs] = oddsFor(matchup, {
      rows,
      states: states({ BUF: { where: "post", left: 0 }, MIA: { where: "post", left: 0 } }),
      draws: 500,
    });

    expect(mine).toBe(1);
    expect(theirs).toBe(0);
  });

  it("keeps a big lead with one player left to play", () => {
    const rows = rowsFor(row("done", "BUF", 12), row("late", "LA", 14));
    const matchup: Matchup = {
      sides: [
        side("me", 132, [{ key: "done", slot: "WR", points: 132 }]),
        side("you", 100, [
          { key: "done", slot: "WR", points: 100 },
          { key: "late", slot: "WR", points: 0 },
        ]),
      ],
    };
    const [mine] = oddsFor(matchup, {
      rows,
      states: states({
        BUF: { where: "post", left: 0 },
        LA: { where: "pre", left: 1 },
      }),
      draws: 2000,
    });

    expect(mine).toBeGreaterThan(0.9);
  });

  it("adds a scaled draw to what a player in a live game has already", () => {
    const rows = rowsFor(row("playing", "KC", 20));
    const totals = sideTotals(
      side("me", 8, [{ key: "playing", slot: "WR", points: 8 }]),
      rows,
      states({ KC: { where: "in", left: 0.5 } }),
      4000,
    );
    const mean = totals.reduce((sum, n) => sum + n, 0) / totals.length;

    // eight on the board plus half of a twenty point week
    expect(mean).toBeGreaterThan(8 + 0.5 * 20 - 1.5);
    expect(mean).toBeLessThan(8 + 0.5 * 20 + 1.5);
  });

  it("gives a kicker nobody has a line on the position's stock week", () => {
    const totals = sideTotals(
      side("me", 0, [{ key: "nobody", slot: "K", points: 0, team: "KC" }]),
      new Map(),
      states({ KC: { where: "pre", left: 1 } }),
      4000,
    );

    expect(mean(totals)).toBeGreaterThan(6);
    expect(mean(totals)).toBeLessThan(10);
  });

  it("reads a kicker with points and no team as done, not yet to kick off", () => {
    const totals = sideTotals(
      side("me", 12, [{ key: "nobody", slot: "K", points: 12 }]),
      new Map(),
      states({}),
      400,
    );

    expect(mean(totals)).toBe(12);
  });

  it("finds the game of a kicker nobody has a line on by his team", () => {
    const totals = sideTotals(
      side("me", 12, [{ key: "nobody", slot: "K", points: 12, team: "JAX" }]),
      new Map(),
      states({ JAX: { where: "post", left: 0 } }),
      400,
    );

    expect(mean(totals)).toBe(12);
  });

  it("scores a player in no stock position on his points alone", () => {
    const totals = sideTotals(
      side("me", 5, [{ key: "nobody", slot: "WR", points: 5 }]),
      new Map(),
      states({}),
      20,
    );

    expect(new Set(totals)).toEqual(new Set([5]));
  });
});

describe("spreadOf", () => {
  it("takes the quartiles a slate ships", () => {
    const his = spreadOf({ ...row("Ja'Marr", "CIN", 16), q1: 9, q3: 21 });

    expect(his.q1).toBe(9);
    expect(his.q3).toBe(21);
  });

  it("puts them halfway when the slate has none", () => {
    const his = spreadOf(row("Ja'Marr", "CIN", 10));

    expect(his.q1).toBeCloseTo(7);
    expect(his.q3).toBeCloseTo(14);
  });
});

describe("stockLine", () => {
  it("has a kicker and a defence, and nobody else", () => {
    expect(stockLine("K")?.blend).toBe(8);
    expect(stockLine("DEF")?.blend).toBe(7);
    expect(stockLine("WR")).toBeNull();
  });

  it("marks the line as stock, so a page can say so", () => {
    expect(stockLine("K")?.stock).toBe(true);
  });
});

describe("initialForm", () => {
  it("cuts the first name to an initial", () => {
    expect(initialForm("Christian McCaffrey")).toBe("C. McCaffrey");
  });

  it("keeps everything after the first name", () => {
    expect(initialForm("Michael Pittman Jr.")).toBe("M. Pittman Jr.");
  });

  it("leaves a one word name alone", () => {
    expect(initialForm("BUF")).toBe("BUF");
  });
});

describe("alternativesFor", () => {
  const rows = rowsFor(
    row("scrub", "BUF", 4),
    row("stud", "KC", 22),
    row("started", "DEN", 12),
    row("keeper", "LA", 11, "QB"),
  );
  const mySide: Side = {
    owner: "me",
    points: 0,
    starters: [
      { key: "keeper", slot: "QB", points: 0 },
      { key: "started", slot: "WR", points: 0 },
    ],
    bench: [
      { key: "stud", points: 0 },
      { key: "scrub", points: 0 },
    ],
  };
  const them: Side = {
    owner: "them",
    points: 0,
    starters: [{ key: "scrub2", slot: "WR", points: 12 }],
    bench: [],
  };
  const choices = alternativesFor(mySide, them, ["QB", "WR"], {
    rows,
    states: states({ BUF: { where: "pre", left: 1 }, KC: { where: "pre", left: 1 },
      DEN: { where: "pre", left: 1 }, LA: { where: "pre", left: 1 } }),
  });

  it("gives one section per slot, in lineup order", () => {
    expect(choices.map((c) => c.slot)).toEqual(["QB", "WR"]);
  });

  it("only offers players the slot takes", () => {
    expect(choices[0]!.options).toEqual([]);
    expect(choices[1]!.options.map((o) => o.key)).toEqual(["stud", "scrub"]);
  });

  it("puts the player who helps most first, and prices him above zero", () => {
    expect(choices[1]!.options[0]!.gains).toBeGreaterThan(0);
    expect(choices[1]!.options[1]!.gains).toBeLessThan(0);
  });

  it("explains the close call and says nothing about the wide gap", () => {
    const close = rowsFor(
      row("near", "DEN", 12), row("alike", "LA", 11.4),
      row("keeper", "SEA", 11, "QB"));
    const slot: Side = {
      owner: "me",
      points: 0,
      starters: [
        { key: "keeper", slot: "QB", points: 0 },
        { key: "near", slot: "WR", points: 0 },
      ],
      bench: [{ key: "alike", points: 0 }],
    };
    const level: Side = {
      owner: "them",
      points: 0,
      starters: [{ key: "nobody", slot: "WR", points: 23 }],
      bench: [],
    };
    const calls = alternativesFor(
      slot, level, ["QB", "WR"], { rows: close, states: states({}) });
    const why = calls[1]!.options[0]!.why!;

    expect(why.points + why.spread + why.opponent + why.ownLineup)
      .toBeCloseTo(why.gains, 10);
    expect(choices[1]!.options.find((o) => o.key === "stud")!.why)
      .toBeUndefined();
  });

  it("marks a player whose game has kicked off as locked", () => {
    const shut = alternativesFor(mySide, them, ["QB", "WR"], {
      rows, states: states({ KC: { where: "in", left: 0.5 } }),
    });

    expect(shut[1]!.options.find((o) => o.key === "stud")!.locked).toBe(true);
  });

  it("says how often each bench player beats the starter", () => {
    const [stud, scrub] = choices[1]!.options;

    expect(stud!.outscores).toBeGreaterThan(0.6);
    expect(scrub!.outscores).toBeLessThan(0.4);
  });
});

describe("outscoreShare", () => {
  it("counts the draws the bench player takes", () => {
    expect(outscoreShare([10, 2, 9, 1], [4, 8, 3, 7])).toBe(0.5);
    expect(outscoreShare([10, 12, 9, 11], [4, 8, 3, 7])).toBe(1);
  });

  it("splits a tie between the two of them", () => {
    expect(outscoreShare([6, 6, 9, 1], [6, 6, 3, 7])).toBe(0.5);
  });

  it("gives nothing away with no draws to read", () => {
    expect(outscoreShare([], [])).toBe(0);
  });
});

function corr(a: number[], b: number[]): number {
  const mean = (its: number[]) =>
    its.reduce((sum, n) => sum + n, 0) / its.length;
  const [ma, mb] = [mean(a), mean(b)];
  let top = 0;
  let sa = 0;
  let sb = 0;

  for (let i = 0; i < a.length; i++) {
    top += (a[i]! - ma) * (b[i]! - mb);
    sa += (a[i]! - ma) ** 2;
    sb += (b[i]! - mb) ** 2;
  }

  return top / Math.sqrt(sa * sb);
}

const mean = (its: number[]) =>
  its.reduce((sum, n) => sum + n, 0) / its.length;

const at = (its: number[], q: number) =>
  [...its].sort((a, b) => a - b)[Math.floor(q * its.length)]!;

describe("liveDraws", () => {
  const stack = rowsFor(
    row("qb", "BUF", 22, "QB", "MIA"),
    row("wr", "BUF", 18, "WR", "MIA"),
    row("def", "MIA", 8, "DEF", "BUF"),
    row("far", "KC", 16, "WR", "DEN"),
  );
  const toPlay = states({
    BUF: { where: "pre", left: 1 },
    MIA: { where: "pre", left: 1 },
    KC: { where: "pre", left: 1 },
    DEN: { where: "pre", left: 1 },
  });
  const players = ["qb", "wr", "def", "far"].map((key) => ({ key, points: 0 }));

  it("moves two players in the same game together and leaves two games apart", () => {
    const live = liveDraws(players, stack, toPlay, 4000);

    expect(corr(live.toCome("qb"), live.toCome("wr"))).toBeGreaterThan(0.3);
    expect(Math.abs(corr(live.toCome("qb"), live.toCome("far"))))
      .toBeLessThan(0.05);
  });

  it("leaves a player's own week where it was before anybody shared a factor", () => {
    const live = liveDraws(players, stack, toPlay, 8000);
    const his = live.toCome("wr");
    const alone = weeksFromSpread(
      { ev: 18, mid: 18, low: 7.2, high: 32.4, q1: 12.6, q3: 25.2 },
      "wr",
      8000,
    );

    expect(mean(his)).toBeCloseTo(mean(alone), 0);

    for (const q of [0.1, 0.5, 0.9]) {
      expect(at(his, q)).toBeCloseTo(at(alone, q), 0);
    }
  });

  it("lifts a teammate and sinks the other defence when a player runs hot", () => {
    const half = states({
      BUF: { where: "in", left: 0.5 },
      MIA: { where: "in", left: 0.5 },
      KC: { where: "pre", left: 1 },
      DEN: { where: "pre", left: 1 },
    });
    const otherwise = ["wr", "def", "far"].map((key) => ({ key, points: 0 }));
    const onPace = liveDraws(
      [{ key: "qb", points: 11 }, ...otherwise], stack, half, 6000);
    const hot = liveDraws(
      [{ key: "qb", points: 34 }, ...otherwise], stack, half, 6000);

    expect(mean(hot.toCome("wr"))).toBeGreaterThan(mean(onPace.toCome("wr")));
    expect(mean(hot.toCome("def"))).toBeLessThan(mean(onPace.toCome("def")));
    expect(hot.toCome("far")).toEqual(onPace.toCome("far"));
  });

  it("moves a receiver's remaining week under 4 points on one long score", () => {
    const early = states({
      BUF: { where: "in", left: 0.8 },
      MIA: { where: "in", left: 0.8 },
      KC: { where: "pre", left: 1 },
      DEN: { where: "pre", left: 1 },
    });
    // a 60 yard catch and score at a fifth played is 13 PPR points, which
    // is a fifth of a 65 point week and reads as the 99.8th percentile
    const onPace = liveDraws(
      [{ key: "wr", points: 3.6 }], stack, early, 8000);
    const hot = liveDraws([{ key: "wr", points: 13 }], stack, early, 8000);
    const lift = mean(hot.toCome("wr")) - mean(onPace.toCome("wr"));

    // the weight of q gave him 8.2 more points over the rest of his week
    expect(lift).toBeGreaterThan(0);
    expect(lift).toBeLessThan(4);
  });
});

describe("a player the slate leaves out", () => {
  const board = new Map([["buf", {
    name: "BUF",
    key: "buf",
    position: "DEF",
    team: "BUF",
    game: { ev: 9, q1: 5, mid: 8.5, q3: 12, low: 3, high: 16 },
  }]]);

  it("draws his week off the board when the week has no row for him", () => {
    const totals = sideTotals(
      side("me", 0, [{ key: "buf", slot: "DEF", points: 0 }]),
      new Map(),
      states({ BUF: { where: "pre", left: 1 } }),
      4000,
      undefined,
      board,
    );

    expect(mean(totals)).toBeGreaterThan(6);
    expect(mean(totals)).toBeLessThan(12);
  });

  it("takes the engine's draws for a defence in a live game", () => {
    const its = [-3, 1, 6];
    const live = liveDraws(
      [{ key: "buf", slot: "DEF", points: 10 }],
      new Map(),
      states({ BUF: { where: "in", left: 0.4 } }),
      6,
      board,
      new Map([["buf", its]]),
    );

    expect(live.toCome("buf")).toEqual([...its, ...its]);
    expect(live.drawingOf("buf")).toBeNull();
  });

  it("says nothing about a player neither the week nor the board has", () => {
    expect(starterState({ key: "nobody" }, new Map(), states({}), board))
      .toBeNull();
    expect(starterState({ key: "buf" }, new Map(), states({}), board))
      .toEqual({ where: "pre", left: 1 });
  });
});

describe("bestLineupFor", () => {
  const rows = rowsFor(
    row("scrub", "BUF", 4),
    row("stud", "KC", 22),
    row("kept", "DEN", 14),
    row("locked", "LA", 3),
  );
  const yetToPlay = states({
    BUF: { where: "pre", left: 1 },
    KC: { where: "pre", left: 1 },
    DEN: { where: "pre", left: 1 },
    LA: { where: "in", left: 0.5 },
  });
  const them = side("you", 0, [{ key: "kept", slot: "WR", points: 0 }]);

  it("starts the better player off the bench", () => {
    const mine: Side = {
      owner: "me",
      points: 0,
      starters: [{ key: "scrub", slot: "WR", points: 0 }],
      bench: [{ key: "stud", points: 0 }],
    };
    const best = bestLineupFor(
      mine, them, ["WR"], { rows, states: yetToPlay, draws: 3000 });

    expect(best.swaps).toHaveLength(1);
    expect(best.swaps[0]).toMatchObject({ starts: "stud", benches: "scrub", slot: "WR" });
    expect(best.starters.map((s) => s.key)).toEqual(["stud"]);
    expect(best.odds).toBeGreaterThan(0.5);
    expect(best.swaps[0]!.outscores).toBeGreaterThan(0.8);
  });

  it("leaves a starter whose game has kicked off where he is", () => {
    const mine: Side = {
      owner: "me",
      points: 2,
      starters: [{ key: "locked", slot: "WR", points: 2 }],
      bench: [{ key: "stud", points: 0 }],
    };
    const best = bestLineupFor(
      mine, them, ["WR"], { rows, states: yetToPlay, draws: 3000 });

    expect(best.swaps).toEqual([]);
    expect(best.starters.map((s) => s.key)).toEqual(["locked"]);
  });
});

describe("fractionLeft", () => {
  it("counts the quarters still to come and the clock in this one", () => {
    expect(fractionLeft(1, "15:00")).toBeCloseTo(1, 5);
    expect(fractionLeft(3, "15:00")).toBeCloseTo(0.5, 5);
    expect(fractionLeft(4, "0:00")).toBeCloseTo(0, 5);
    expect(fractionLeft(5, "10:00")).toBeCloseTo(10 / 60, 5);
  });
});

describe("clockLeftOf", () => {
  it("counts the quarters still to come", () => {
    expect(clockLeftOf({ period: 3, clock: 600 }))
      .toEqual({ secondsLeft: 1500, overtimeLeft: 0 });
  });

  it("puts an overtime clock somewhere other than zero", () => {
    expect(clockLeftOf({ period: 5, clock: 240 }))
      .toEqual({ secondsLeft: 0, overtimeLeft: 240 });
  });
});

describe("nextKickoffFrom", () => {
  it("gives the earliest kickoff among games not yet started", () => {
    const got = nextKickoffFrom({
      events: [
        { date: "2026-09-27T17:00Z", status: { type: { state: "in" } } },
        { date: "2026-09-27T20:25Z", status: { type: { state: "pre" } } },
        { date: "2026-09-28T00:20Z", status: { type: { state: "pre" } } },
      ],
    });

    expect(got).toBe(Date.parse("2026-09-27T20:25Z"));
  });

  it("gives null once every game has started", () => {
    expect(nextKickoffFrom({
      events: [{ date: "2026-09-27T17:00Z", status: { type: { state: "post" } } }],
    })).toBeNull();
  });
});

describe("statesFrom", () => {
  it("reads both sides of a game and renames the codes the board spells differently", () => {
    const got = statesFrom({
      events: [{
        competitions: [{
          status: { period: 2, displayClock: "7:30", type: { state: "in" } },
          competitors: [
            { team: { abbreviation: "WSH" } },
            { team: { abbreviation: "LAR" } },
          ],
        }],
      }, {
        status: { type: { state: "pre" } },
        competitions: [{
          competitors: [
            { team: { abbreviation: "JAX" } },
            { team: { abbreviation: "NE" } },
          ],
        }],
      }],
    });

    expect(got.get("WAS")).toEqual({
      where: "in", left: (30 + 7.5) / 60,
    });
    expect(got.get("LA")?.where).toBe("in");
    expect(got.get("JAX")).toEqual({ where: "pre", left: 1 });
    expect(got.has("WSH")).toBe(false);
  });

  it("hands a finished game's box score to both of its teams", () => {
    const stats = new Map([["derrickhenry", {
      passCmp: 0, passAtt: 0, passYds: 0, passTd: 0, interceptions: 0,
      carries: 18, rushYds: 117, rushTd: 3,
      receptions: 0, targets: 0, recYds: 0, recTd: 0,
      fgm: 0, fga: 0, xpm: 0, xpa: 0, fumblesLost: 0,
    }]]);
    const got = statesFrom({
      events: [{
        id: "401872659",
        status: { type: { state: "post" } },
        competitions: [{
          competitors: [
            { team: { abbreviation: "BAL" } },
            { team: { abbreviation: "IND" } },
          ],
        }],
      }],
    }, new Map([["401872659", { hurt: new Map(), stats, defences: new Map() }]]));

    expect(got.get("BAL")?.stats?.get("derrickhenry")?.rushYds).toBe(117);
    expect(got.get("IND")?.stats).toBe(stats);
    expect(got.get("BAL")).not.toHaveProperty("hurt");
  });
});

describe("situationsFrom", () => {
  it("reads the ball, the clock and the timeouts off a game in the third", () => {
    const got = situationsFrom({
      events: [{
        competitions: [{
          status: {
            period: 3, clock: 420, displayClock: "7:00", type: { state: "in" },
          },
          situation: {
            possession: "12",
            yardLine: 28,
            down: 2,
            distance: 7,
            homeTimeouts: 2,
            awayTimeouts: 3,
            isRedZone: false,
          },
          competitors: [
            {
              homeAway: "home", score: "17",
              team: { id: "12", abbreviation: "KC" },
            },
            {
              homeAway: "away", score: "10",
              team: { id: "2", abbreviation: "BUF" },
            },
          ],
        }],
      }],
    });

    const live = got.get("KC");

    expect(got.get("BUF")).toBe(live);
    expect(live?.home).toBe("KC");
    expect(live?.away).toBe("BUF");
    expect(live?.points).toEqual({ KC: 17, BUF: 10 });
    expect(live?.secondsLeft).toBe(1320);
    expect(live?.withBall).toBe("KC");
    expect(live?.yardline).toBe(72);
    expect(live?.down).toBe(2);
    expect(live?.toGo).toBe(7);
    expect(live?.timeouts).toEqual({ KC: 2, BUF: 3 });
    expect(live?.redZone).toBe(false);
    expect(live?.secondHalf).toBe(true);
    expect(live?.warningLeft).toBe(true);
  });

  it("still gives the score and the clock between plays, with no ball", () => {
    const got = situationsFrom({
      events: [{
        competitions: [{
          status: {
            period: 4, clock: 45, displayClock: "0:45", type: { state: "in" },
          },
          competitors: [
            {
              homeAway: "home", score: "24",
              team: { id: "28", abbreviation: "WSH" },
            },
            {
              homeAway: "away", score: "31",
              team: { id: "14", abbreviation: "LAR" },
            },
          ],
        }],
      }, {
        status: { type: { state: "post" } },
        competitions: [{
          competitors: [
            {
              homeAway: "home", score: "3",
              team: { id: "17", abbreviation: "NE" },
            },
            {
              homeAway: "away", score: "9",
              team: { id: "20", abbreviation: "NYJ" },
            },
          ],
        }],
      }],
    });

    const live = got.get("WAS");

    expect(got.get("LA")).toBe(live);
    expect(live?.points).toEqual({ WAS: 24, LA: 31 });
    expect(live?.secondsLeft).toBe(45);
    expect(live?.timeouts).toEqual({ WAS: 3, LA: 3 });
    expect(live?.withBall).toBeUndefined();
    expect(live?.yardline).toBeUndefined();
    expect(live?.down).toBeUndefined();
    expect(live?.toGo).toBeUndefined();
    expect(live?.redZone).toBe(false);
    expect(live?.secondHalf).toBe(true);
    expect(live?.warningLeft).toBe(false);
    expect(got.has("NE")).toBe(false);
  });

  it("counts no time left once a game goes to overtime", () => {
    const got = situationsFrom({
      events: [{
        competitions: [{
          status: { period: 5, clock: 300, type: { state: "in" } },
          competitors: [
            {
              homeAway: "home", score: "20",
              team: { id: "6", abbreviation: "DAL" },
            },
            {
              homeAway: "away", score: "20",
              team: { id: "21", abbreviation: "PHI" },
            },
          ],
        }],
      }],
    });

    expect(got.get("DAL")?.secondsLeft).toBe(0);
    expect(got.get("DAL")?.warningLeft).toBe(false);
  });
});

describe("standingFor", () => {
  it("hands back a still to come for each starter that sums to the side's total", () => {
    const rows = rowsFor(
      row("qb", "BUF", 22, "QB", "MIA"), row("wr", "BUF", 18, "WR", "MIA"),
      row("rb", "KC", 14, "RB", "DEN"), row("k", "SF", 8, "K", "SEA"),
      row("far", "MIA", 12, "WR", "BUF"), row("te", "DEN", 6, "TE", "KC"),
    );
    const now = states({
      BUF: { where: "in", left: 0.4 }, MIA: { where: "in", left: 0.4 },
      KC: { where: "pre", left: 1 }, DEN: { where: "pre", left: 1 },
      SF: { where: "post", left: 0 }, SEA: { where: "post", left: 0 },
    });
    const game: Matchup = { sides: [
      side("me", 30, [
        { key: "qb", points: 15, slot: "QB" }, { key: "wr", points: 3, slot: "WR" },
        { key: "rb", points: 0, slot: "RB" }, { key: "k", points: 12, slot: "K" },
      ]),
      side("them", 4, [
        { key: "far", points: 4, slot: "WR" }, { key: "te", points: 0, slot: "TE" },
      ]),
    ] };
    const remainder = new Map([["wr", [5, 7, 9]]]);
    const standing = standingFor(
      game, { rows, states: now, draws: 2000, remainder });

    for (const [at, his] of game.sides.entries()) {
      const summed = his.starters.reduce(
        (sum, s) => sum + s.points + standing.toCome.get(s.key)!, 0);

      expect(summed).toBeCloseTo(standing.projected[at]!, 6);
    }
  });

  it("gives the lineup advice the same chance as the card, once a game is played out", () => {
    const rows = rowsFor(
      row("wr", "BUF", 16, "WR", "MIA"), row("far", "MIA", 12, "WR", "BUF"),
    );
    const now = states({
      BUF: { where: "in", left: 0.4 }, MIA: { where: "in", left: 0.4 },
    });
    const me = side("me", 3, [{ key: "wr", points: 3, slot: "WR" }]);
    const them = side("them", 14, [{ key: "far", points: 14, slot: "WR" }]);
    // the engine says he has a big second half coming
    const remainder = new Map([["wr", Array.from({ length: 64 }, () => 20)]]);
    const week = { rows, states: now, remainder };

    const card = standingFor({ sides: [me, them] }, week).odds[0];
    const best = bestLineupFor(me, them, ["WR"], week);
    const without = standingFor({ sides: [me, them] }, { rows, states: now }).odds[0];

    expect(best.odds).toBeCloseTo(card, 10);
    expect(Math.abs(card - without)).toBeGreaterThan(0.05);
  });

  it("gives a finished loser 0% and the winner 100%, however the sides are ordered", () => {
    const rows = rowsFor(row("qb", "BUF", 95, "QB", "MIA"));
    const now = states({ BUF: { where: "post", left: 0 } });
    // the defence has no team on it, the way one nobody has a line on
    // shows up, and it gave up a lot of points, so its own score is
    // negative rather than the zero a game that has not kicked off reads as
    const mine = side("me", 92, [
      { key: "qb", points: 95, slot: "QB" },
      { key: "def", points: -3, slot: "DEF" },
    ]);
    const theirs = side("them", 100, [{ key: "qb2", points: 100, slot: "QB" }]);

    // the summary line always puts your own side first
    const summary = standingFor({ sides: [mine, theirs] }, { rows, states: now });

    expect(summary.odds).toEqual([0, 1]);

    // the card draws the game in whichever order the league handed it
    // back, and it has to land on the same answer either way
    const card = standingFor({ sides: [theirs, mine] }, { rows, states: now });

    expect(card.odds).toEqual([1, 0]);
  });

  it("reports no lineup rather than a zero projection for an empty side", () => {
    const rows = rowsFor(row("qb2", "KC", 24, "QB", "DEN"));
    const now = states({ KC: { where: "pre", left: 1 }, DEN: { where: "pre", left: 1 } });
    const empty = side("me", 0, []);
    const theirs = side("them", 0, [{ key: "qb2", points: 0, slot: "QB" }]);

    expect(hasLineup(empty)).toBe(false);

    const standing = standingFor({ sides: [empty, theirs] }, { rows, states: now });

    expect(standing.projected[0]).toBe(0);
    // nobody has played and the empty side may still set a lineup, so
    // one side having nobody in it does not decide the game
    expect(standing.odds).toEqual([0.5, 0.5]);
  });
});

describe("hurtFrom", () => {
  const said = JSON.parse(readFileSync(
    join(import.meta.dirname, "..", "fixtures", "espnSummaryInjuries.json"),
    "utf8",
  )) as Parameters<typeof hurtFrom>[0];

  it("has a player listed questionable since kickoff questionable to return", () => {
    expect(hurtFrom(said).get("zayflowers")).toBe("questionable");
  });

  it("has a player the team sat before kickoff out", () => {
    expect(hurtFrom(said).get("djgiddens")).toBe("out");
  });

  it("leaves a player listed questionable before kickoff playing", () => {
    const before = {
      header: { competitions: [{ date: "2026-09-13T17:00Z" }] },
      injuries: [{
        injuries: [{
          status: "Questionable",
          date: "2026-09-13T15:30Z",
          athlete: { displayName: "Derrick Henry" },
        }],
      }],
    };

    expect(hurtFrom(before).size).toBe(0);
  });

  it("reads a player doubtful to return", () => {
    const gone = {
      header: { competitions: [{ date: "2026-09-13T17:00Z" }] },
      injuries: [{
        injuries: [{
          status: "Doubtful",
          date: "2026-09-13T18:55Z",
          athlete: { displayName: "Minkah Fitzpatrick" },
        }],
      }],
    };

    expect(hurtFrom(gone).get("minkahfitzpatrick")).toBe("doubtful");
  });
});

describe("liveDraws for a player who has gone off", () => {
  const mean = (its: number[]) =>
    its.reduce((sum, n) => sum + n, 0) / its.length;

  it("leaves an out player nothing and halves a questionable one", () => {
    const rows = rowsFor(
      row("gone", "BUF", 12), row("iffy", "BUF", 12), row("fit", "BUF", 12));
    const hurt = new Map<string, InGameStatus>([
      ["gone", "out"], ["iffy", "questionable"],
    ]);
    const live = liveDraws(
      [
        { key: "gone", slot: "WR", points: 4 },
        { key: "iffy", slot: "WR", points: 4 },
        { key: "fit", slot: "WR", points: 4 },
      ],
      rows,
      states({ BUF: { where: "in", left: 0.5, hurt } }),
      600,
    );
    const fit = mean(live.toCome("fit"));

    expect(mean(live.toCome("gone"))).toBe(0);
    expect(mean(live.toCome("iffy")) / fit).toBeGreaterThan(0.3);
    expect(mean(live.toCome("iffy")) / fit).toBeLessThan(0.75);
  });
});

describe("myGameIn", () => {
  const side = (owner: string, ownerId?: string) => ({
    owner, ...(ownerId ? { ownerId } : {}), points: 0,
    starters: [], bench: [],
  });

  it("finds your side by id when the team has been renamed", () => {
    const games = [{ sides: [side("New Name", "7"), side("Theirs", "8")] }] as
      Parameters<typeof myGameIn>[0];

    expect(myGameIn(games, "Old Name", "7")?.at).toBe(0);
  });

  it("falls back to the name where the provider gives no id", () => {
    const games = [{ sides: [side("Mine"), side("Theirs")] }] as
      Parameters<typeof myGameIn>[0];

    expect(myGameIn(games, "Mine", "7")?.at).toBe(0);
    expect(myGameIn(games, "Nobody", "7")).toBe(null);
  });
});

const fixture = <T>(name: string) => JSON.parse(readFileSync(
  join(import.meta.dirname, "..", "fixtures", name), "utf8")) as T;

/**
 * Falcons at Packers on a Thursday night, read off ESPN's scoreboard and
 * Sleeper's scores within a second of each other: Atlanta with the ball
 * at its own 47, second and eight, early in the fourth.
 */
const espnBoard = fixture<Parameters<typeof situationsFrom>[0]>(
  "espnScoreboardLive.json");

describe("the yard line on ESPN's scoreboard", () => {
  it("reads the away side at its own 47 as 53 yards out", () => {
    const live = situationsFrom(espnBoard).get("ATL")!;

    expect(live.withBall).toBe("ATL");
    expect(live.yardline).toBe(53);
    expect(live.down).toBe(2);
    expect(live.toGo).toBe(8);
  });
});
