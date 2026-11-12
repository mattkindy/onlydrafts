import { describe, expect, it } from "vitest";

import { picksHeld, type League } from "./providers.ts";
import type { Player } from "./scoring.ts";
import {
  draftCurve, dynastyValue, evenUp, evenWithin, keeperGain, keptValue, NO_DEAL, overallPick,
  overTheLimit, pickValue, restOfSeason, rostersAfter, SEASON_OUT, seasonsAhead, slotsFromWins,
  stageOf, tradeVerdict, type Offer,
} from "./trade.ts";

const player = (over: Partial<Player>): Player =>
  ({ name: "x", key: "x", position: "RB", ...over }) as Player;

describe("a player's rest of the season", () => {
  it("is what he beats a replacement by, for the games he is expected to play", () => {
    const p = player({ perGameVor: 4, weeksLeft: { from: 11, plays: [1, 1, 0.5, 1, 1, 1, 1] } });

    expect(restOfSeason(p, 4)).toBeCloseTo(4 * 3.5);
  });

  it("is nothing for a player below replacement, who can be cut", () => {
    expect(restOfSeason(player({ perGameVor: -2, games: 17 }), 6)).toBe(0);
  });

  it("falls back to his games over a season without a week by week chance", () => {
    expect(restOfSeason(player({ perGameVor: 3, games: 17 }), 5)).toBeCloseTo(15);
  });
});

describe("a draft pick", () => {
  const board = Array.from({ length: 200 }, (_, i) =>
    player({ key: "p" + i, adpRank: i + 1, vor: Math.max(0, 200 - i * 2) }));
  const curve = draftCurve(board);
  const base = { curve, teams: 12, snake: true, season: 2026 };

  it("is worth more early in the draft than late", () => {
    expect(curve(1)).toBeGreaterThan(curve(12));
    expect(curve(12)).toBeGreaterThan(curve(60));
  });

  it("falls where the team it came from finishes, worst picking first", () => {
    const slots = slotsFromWins([{ owner: "a", wins: 3 }, { owner: "b", wins: 10 }]);
    const from = (owner: string) => ({ season: 2027, round: 1, from: owner, owner: "me" });
    const at = (owner: string) => pickValue(from(owner), { ...base, slotOf: (o) => slots.get(o) ?? null });

    expect(slots.get("a")).toBe(1);
    expect(at("a")).toBeGreaterThan(at("b"));
  });

  it("snakes back in the even rounds", () => {
    expect(overallPick(2, 1, 12, true)).toBe(24);
    expect(overallPick(2, 1, 12, false)).toBe(13);
  });

  it("is priced at every slot alike, and less, a season further off", () => {
    const next = pickValue({ season: 2027, round: 1, from: "a", owner: "me" }, { ...base, slotOf: () => null });
    const after = pickValue({ season: 2028, round: 1, from: "a", owner: "me" }, { ...base, slotOf: () => 1 });

    expect(after).toBeCloseTo(next * SEASON_OUT);
  });
});

describe("who holds a pick", () => {
  it("is the team it began with, unless Sleeper lists it traded", () => {
    const picks = picksHeld({
      rosters: [{ roster_id: 1 }, { roster_id: 2 }],
      traded: [{ season: "2027", round: 1, roster_id: 2, owner_id: 1 }],
      seasons: [2027],
      rounds: 2,
      ownerOf: (id) => (id === 1 ? "me" : "them"),
    });
    const held = (owner: string) => picks.filter((p) => p.owner === owner)
      .map((p) => `${p.round} from ${p.from}`);

    expect(held("me")).toEqual(["1 from me", "1 from them", "2 from me"]);
    expect(held("them")).toEqual(["2 from them"]);
  });
});

describe("the rosters after a deal", () => {
  const league = {
    team: "me",
    slots: ["QB", "RB", "BN", "IR"],
    allRosters: [
      { owner: "me", picks: [], keys: [{ key: "a", name: "A", pos: "RB" }, { key: "b", name: "B", pos: "WR" }] },
      { owner: "them", picks: [], keys: [{ key: "c", name: "C", pos: "QB" }] },
    ],
  } as unknown as League;

  it("swaps what each side sends", () => {
    const after = rostersAfter(league, { ...NO_DEAL("them"), give: ["a"], get: ["c"] });

    expect(after.find((r) => r.owner === "me")!.keys.map((p) => p.key)).toEqual(["b", "c"]);
    expect(after.find((r) => r.owner === "them")!.keys.map((p) => p.key)).toEqual(["a"]);
  });

  it("says how many a side must drop to stay inside its roster", () => {
    const deal = { ...NO_DEAL("me"), partner: "them", get: ["c"] };

    expect(overTheLimit(league, deal, "mine")).toBe(0);
    expect(overTheLimit(league, { ...deal, get: ["c", "d"] }, "mine")).toBe(1);
  });
});

describe("what the trade says", () => {
  it("reads buying now with later as right for a contender and wrong for a long shot", () => {
    const deal = { now: 0.04, theirs: -0.01, later: -60 };

    expect(tradeVerdict({ ...deal, stage: "contender" }).tone).toBe("up");
    expect(tradeVerdict({ ...deal, stage: "bubble" }).tone).toBe("flat");
    expect(tradeVerdict({ ...deal, stage: "long shot" }).tone).toBe("down");
  });

  it("reads selling now for later the other way round", () => {
    const deal = { now: -0.03, theirs: 0.02, later: 80 };

    expect(tradeVerdict({ ...deal, stage: "out of it" }).says).toBe("sells a lost season for later");
    expect(tradeVerdict({ ...deal, stage: "contender" }).tone).toBe("down");
  });

  it("calls under a point either way even", () => {
    expect(tradeVerdict({ now: 0, theirs: 0, later: 0, stage: "bubble" }).says).toBe("about even");
  });

  it("places a team by its chance of the playoffs", () => {
    expect(stageOf(0.9)).toBe("contender");
    expect(stageOf(0.4)).toBe("bubble");
    expect(stageOf(0.1)).toBe("long shot");
    expect(stageOf(0.01)).toBe("out of it");
  });
});

describe("a player's seasons to come", () => {
  // a rookie on 11 a game now, a 15 a game back next season
  const rookie = player({
    ppg: 11, replacementPpg: 9,
    ahead: [{ of: 1.4, games: 14 }, { of: 1.5, games: 15 }, { of: 1.4, games: 14 }],
  });

  it("is what he beats this season's replacement by, over the games he is expected to play", () => {
    expect(seasonsAhead(rookie)![0]).toBeCloseTo((11 * 1.4 - 9) * 14);
  });

  it("says nothing where the board says nothing of his next seasons", () => {
    expect(seasonsAhead(player({ ppg: 11, replacementPpg: 9 }))).toBeNull();
    expect(dynastyValue(player({ ppg: 11, replacementPpg: 9 }))).toBeNull();
  });

  it("is worth less a season further off, as a pick further off is", () => {
    const [a, b, c] = seasonsAhead(rookie)!;

    expect(dynastyValue(rookie)).toBeCloseTo(a! + b! * SEASON_OUT + c! * SEASON_OUT ** 2);
  });

  it("never falls below nothing, since a player below replacement can be cut", () => {
    expect(seasonsAhead(player({ ppg: 5, replacementPpg: 9, ahead: [{ of: 1, games: 17 }] }))).toEqual([0]);
  });

  it("as a keeper, is next season less the pick he costs", () => {
    const next = seasonsAhead(rookie)![0]!;

    expect(keeperGain(rookie, 30)).toBeCloseTo(next - 30);
    expect(keeperGain(rookie, 1000)).toBe(0);
  });

  it("counts only the keepers a team can keep", () => {
    expect(keptValue([50, 10, 80, 0, 30], 2)).toBe(130);
    expect(keptValue([50, 10], 5)).toBe(60);
  });
});

describe("evening a deal up", () => {
  const offer = (id: string, side: Offer["side"], value: number): Offer =>
    ({ id, kind: "player", side, says: id, value });
  const offers = [
    offer("big", "give", 60), offer("near", "give", 22), offer("small", "give", 8),
    offer("theirs", "get", 20), offer("nothing", "give", 0),
  ];

  it("asks the side coming out ahead for more, closest to the gap first", () => {
    expect(evenUp(20, offers, 3).map((o) => o.offer.id)).toEqual(["near", "small"]);
    expect(evenUp(-18, offers, 3).map((o) => o.offer.id)).toEqual(["theirs"]);
  });

  it("offers only what brings it closer to even", () => {
    // the 60 would leave them 40 ahead where you were 20 ahead
    expect(evenUp(20, offers, 3).some((o) => o.offer.id === "big")).toBe(false);
  });

  it("keeps to players or to picks when asked", () => {
    const mixed = [...offers, { id: "pick", kind: "pick", side: "give", says: "2027 2nd", value: 19 } as Offer];

    expect(evenUp(20, mixed, 3)[0]!.offer.id).toBe("near");
    expect(evenUp(20, mixed, 3, "pick").map((o) => o.offer.id)).toEqual(["pick"]);
    expect(evenUp(20, mixed, 3, "player").some((o) => o.offer.kind === "pick")).toBe(false);
  });

  it("leaves an even deal alone", () => {
    expect(evenUp(2, offers, 3)).toEqual([]);
  });

  it("would rather leave them a little ahead than you", () => {
    const close = [offer("over", "give", 10.5), offer("under", "give", 9.5)];

    expect(evenUp(10, close, 3)[0]!.offer.id).toBe("over");
  });

  it("reads a tenth of the bigger side, or three points, as even", () => {
    expect(evenWithin(10, 12)).toBe(3);
    expect(evenWithin(200, 150)).toBe(20);
  });
});
