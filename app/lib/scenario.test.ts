import { describe, expect, it } from "vitest";

import { legsToRead, sleeperPendingTrades, type League } from "./providers.ts";
import {
  applyMoves, dealToMove, isOn, moveToDeal, NO_SCENARIO, nudged, resultKey, resultsFrom,
  scenarioLeague, teamsIn, toggled, whoGetsWhat, type Move,
} from "./scenario.ts";
import { pairKey } from "./seasonStats.ts";
import { pickId } from "./trade.ts";

const p = (key: string) => ({ key, name: key.toUpperCase(), pos: "RB" });

const league = (): League => ({
  provider: "sleeper", leagueId: "1", season: 2026, name: "l", size: 3, pays: {}, slots: null,
  userId: "u", team: "me", members: {}, myRoster: [p("a"), p("b")], myPicks: [], draftSlot: null,
  snake: true,
  allRosters: [
    { owner: "me", picks: [], keys: [p("a"), p("b")] },
    { owner: "bo", picks: [], keys: [p("c"), p("d")] },
    { owner: "cy", picks: [], keys: [p("e")] },
  ],
  picks: [
    { season: 2027, round: 1, from: "me", owner: "me" },
    { season: 2027, round: 1, from: "bo", owner: "bo" },
  ],
});

const trade = (id: string, over: Partial<Move> = {}): Move => ({
  id, by: "you",
  players: [
    { ...p("a"), from: "me", to: "bo" },
    { ...p("c"), from: "bo", to: "me" },
  ],
  picks: [],
  ...over,
});

describe("a what-if's moves", () => {
  it("swap the players each side sends", () => {
    const lg = league();
    const after = applyMoves(lg.allRosters, [], [trade("x")]);

    expect(after.rosters.find((r) => r.owner === "me")!.keys.map((k) => k.key)).toEqual(["b", "c"]);
    expect(after.rosters.find((r) => r.owner === "bo")!.keys.map((k) => k.key)).toEqual(["d", "a"]);
    expect(after.rosters.find((r) => r.owner === "cy")).toBe(lg.allRosters[2]);
  });

  it("apply in order, the second to what the first left", () => {
    const lg = league();
    const onward: Move = {
      id: "y", by: "you", picks: [],
      players: [{ ...p("a"), from: "bo", to: "cy" }],
    };
    const after = applyMoves(lg.allRosters, [], [trade("x"), onward]);

    expect(after.rosters.find((r) => r.owner === "cy")!.keys.map((k) => k.key)).toEqual(["e", "a"]);
    expect(after.stale).toEqual([]);
  });

  it("set a move aside whole, and say why, when a player in it has gone elsewhere", () => {
    const lg = league();
    const late: Move = {
      id: "z", by: "you", picks: [],
      players: [{ ...p("e"), from: "cy", to: "me" }, { ...p("a"), from: "me", to: "cy" }],
    };
    const after = applyMoves(lg.allRosters, [], [trade("x"), late]);

    expect(after.applied.map((m) => m.id)).toEqual(["x"]);
    expect(after.stale[0]!.missing).toBe("A is not on me's roster");
    expect(after.rosters.find((r) => r.owner === "cy")!.keys.map((k) => k.key)).toEqual(["e"]);
  });

  it("move picks with the players, and only from the team holding them", () => {
    const lg = league();
    const withPick = trade("x", {
      picks: [{ id: pickId({ season: 2027, round: 1, from: "me" }), season: 2027, round: 1, original: "me", giver: "me", to: "bo" }],
    });
    const after = applyMoves(lg.allRosters, lg.picks!, [withPick]);

    expect(after.picks.find((h) => h.from === "me")!.owner).toBe("bo");

    const wrong = trade("y", {
      picks: [{ id: pickId({ season: 2027, round: 1, from: "bo" }), season: 2027, round: 1, original: "bo", giver: "me", to: "bo" }],
    });

    expect(applyMoves(lg.allRosters, lg.picks!, [wrong]).stale).toHaveLength(1);
  });

  it("let the players through where the league lists no picks to check a pick against", () => {
    const lg = league();
    const withPick = trade("x", {
      picks: [{ id: pickId({ season: 2027, round: 2, from: "bo" }), season: 2027, round: 2, original: "bo", giver: "bo", to: "me" }],
    });
    const after = applyMoves(lg.allRosters, [], [withPick]);

    expect(after.stale).toEqual([]);
    expect(after.rosters[0]!.keys.map((k) => k.key)).toEqual(["b", "c"]);
  });

  it("take a player off waivers only while nobody has him, and cut one to nobody", () => {
    const lg = league();
    const pickup: Move = {
      id: "w", by: "you", picks: [],
      players: [{ ...p("f"), from: null, to: "me" }, { ...p("b"), from: "me", to: null }],
    };
    const after = applyMoves(lg.allRosters, [], [pickup]);

    expect(after.rosters[0]!.keys.map((k) => k.key)).toEqual(["a", "f"]);
    expect(applyMoves(lg.allRosters, [], [{ ...pickup, players: [{ ...p("c"), from: null, to: "me" }] }])
      .stale).toHaveLength(1);
  });
});

describe("the league inside a what-if", () => {
  it("is the league itself with nothing switched on", () => {
    const lg = league();

    expect(scenarioLeague(lg, NO_SCENARIO).league).toBe(lg);
  });

  it("counts a pending trade at once, and leaves one of any other word off until asked", () => {
    const lg = { ...league(), pending: [trade("league:1", { by: "league", status: "pending" })] };
    const odd = { ...league(), pending: [trade("league:2", { by: "league", status: "proposed" })] };

    expect(scenarioLeague(lg, NO_SCENARIO).league.myRoster.map((k) => k.key)).toEqual(["b", "c"]);
    expect(scenarioLeague(odd, NO_SCENARIO).applied).toEqual([]);

    const asked = toggled(NO_SCENARIO, odd.pending[0]!);

    expect(isOn(odd.pending[0]!, asked)).toBe(true);
    expect(scenarioLeague(odd, asked).applied).toHaveLength(1);
    expect(isOn(odd.pending[0]!, toggled(asked, odd.pending[0]!))).toBe(false);
  });

  it("switches a move off and on again", () => {
    const lg = { ...league(), pending: [trade("league:1", { by: "league", status: "pending" })] };
    const off = toggled(NO_SCENARIO, lg.pending[0]!);

    expect(scenarioLeague(lg, off).applied).toEqual([]);
    expect(scenarioLeague(lg, toggled(off, lg.pending[0]!)).applied).toHaveLength(1);
  });
});

describe("a trade built on the trade tab", () => {
  it("becomes a move and comes back as the same deal", () => {
    const lg = league();
    const deal = {
      partner: "bo", give: ["a"], get: ["c", "d"],
      givePicks: [pickId({ season: 2027, round: 1, from: "me" })], getPicks: [],
    };
    const move = dealToMove(deal, lg, "you:1");

    expect(teamsIn(move, "me")).toEqual(["me", "bo"]);
    expect(whoGetsWhat(move, "me").map((t) => [t.owner, t.players.map((x) => x.key), t.picks.length]))
      .toEqual([["me", ["c", "d"], 0], ["bo", ["a"], 1]]);
    expect(moveToDeal(move, "me")).toEqual(deal);
  });

  it("is not a deal to change when it is the league's, or between other teams", () => {
    expect(moveToDeal(trade("league:1", { by: "league" }), "me")).toBeNull();
    expect(moveToDeal(trade("x"), "cy")).toBeNull();
  });
});

describe("results and scoring in a what-if", () => {
  it("are kept by the season's week and handed over by each week's place from the coming one", () => {
    const picks = new Map([
      [resultKey(0, 12, "me", "bo"), "me"],
      [resultKey(2, 12, "cy", "bo"), "cy"],
      [pairKey(11, "me", "cy"), "cy"],
    ]);

    expect([...resultsFrom(picks, 12)]).toEqual([
      [pairKey(0, "me", "bo"), "me"],
      [pairKey(2, "cy", "bo"), "cy"],
    ]);
    // a week later, the first pick's week has been played
    expect([...resultsFrom(picks, 13).keys()]).toEqual([pairKey(1, "bo", "cy")]);
  });

  it("move your own scoring and nobody else's", () => {
    const s = new Map([["me", { mean: 100, sd: 20 }], ["bo", { mean: 100, sd: 20 }]]);
    const out = nudged(s, "me", 0.1);

    expect(out.get("me")!.mean).toBeCloseTo(110);
    expect(out.get("bo")).toBe(s.get("bo"));
    expect(nudged(s, "me", 0)).toBe(s);
  });
});

describe("Sleeper's trades still to go through", () => {
  const owners = new Map([[1, "me"], [2, "bo"]]);
  const playerOf = (id: string) => ({ key: "k" + id, name: "N" + id });

  it("are the trades neither finished nor failed, each player from who drops him to who adds him", () => {
    const moves = sleeperPendingTrades([
      {
        transaction_id: "9", type: "trade", status: "pending", created: 5,
        adds: { "10": 2, "20": 1 }, drops: { "10": 1, "20": 2, "30": 2 },
        draft_picks: [{ season: "2027", round: 2, roster_id: 2, previous_owner_id: 2, owner_id: 1 }],
      },
      { transaction_id: "8", type: "trade", status: "complete", adds: { "1": 1 }, drops: { "1": 2 } },
      { transaction_id: "7", type: "waiver", status: "pending", adds: { "1": 1 } },
      // the same trade read from both weeks
      { transaction_id: "9", type: "trade", status: "pending", adds: {}, drops: {} },
    ], playerOf, (id) => owners.get(id) ?? String(id));

    expect(moves).toHaveLength(1);
    expect(moves[0]!.id).toBe("league:9");
    expect(moves[0]!.players.map((x) => [x.key, x.from, x.to])).toEqual([
      ["k10", "me", "bo"], ["k20", "bo", "me"], ["k30", "bo", null],
    ]);
    expect(moves[0]!.picks).toEqual([{
      id: pickId({ season: 2027, round: 2, from: "bo" }), season: 2027, round: 2,
      original: "bo", giver: "bo", to: "me",
    }]);
  });

  it("are read from this week and the one before", () => {
    expect(legsToRead({ leg: 12 })).toEqual([11, 12]);
    expect(legsToRead({ leg: 1 })).toEqual([1]);
    expect(legsToRead({ leg: 0 })).toEqual([]);
    expect(legsToRead(null)).toEqual([]);
  });
});
