import { describe, expect, it } from "vitest";
import { claimWords, reasonWords, roleWords } from "./sleeperWords.ts";
import type { Sleeper } from "./scoring.ts";

const aSleeper = (over: Partial<Sleeper> = {}): Sleeper => ({
  week: 6,
  price: 180,
  score: 2.1,
  modelPpg: 11.2,
  pricePpg: 9.1,
  reasons: [
    { term: "work share", points: 1.4 },
    { term: "points a game so far", points: 0.9 },
    { term: "pick spread", points: -0.2 },
  ],
  ...over,
});

describe("claimWords", () => {
  it("signs a claim the board is making for a player", () => {
    expect(claimWords(aSleeper())).toBe("+2.1 a game over his price");
  });

  it("leaves a claim against him unsigned", () => {
    expect(claimWords(aSleeper({ score: -1.4 })))
      .toBe("-1.4 a game over his price");
  });
});

describe("reasonWords", () => {
  it("names the terms holding the score up and skips the rest", () => {
    expect(reasonWords(aSleeper())).toBe("work share, scoring so far");
  });
});

describe("roleWords", () => {
  it("says what the job is worth and how likely it is to open", () => {
    expect(roleWords(aSleeper({ wouldAverage: 14.2, roleChance: 0.35 })))
      .toBe("would average 14.2 with the job, about a 35% chance it opens");
  });

  it("says nothing when the board has no contingent parts for him", () => {
    expect(roleWords(aSleeper())).toBe("");
    expect(roleWords(aSleeper({ wouldAverage: 14.2, roleChance: null })))
      .toBe("");
  });

  it("says nothing about a job that is not close", () => {
    expect(roleWords(aSleeper({ wouldAverage: 14.2, roleChance: 0.04 })))
      .toBe("");
  });
});
