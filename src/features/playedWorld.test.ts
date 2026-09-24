import { describe, expect, it } from "vitest";
import { chooseThrower } from "./playedWorld.js";

const qb = (playerId: string) => ({ playerId, position: "QB" });

describe("chooseThrower", () => {
  const adp = new Map([["starter", 40], ["backup", 180]]);
  const evidence = {
    adpOf: (playerId: string) => adp.get(playerId),
    threwLastYear: new Map([["starter", 500], ["backup", 20], ["third", 60]]),
  };

  it("hands the ball to whoever threw most lately when he is dressed", () => {
    const passer = chooseThrower([qb("starter"), qb("backup")], {
      ...evidence,
      lately: new Map([["starter", 20], ["backup", 45]]),
    });

    expect(passer).toBe("backup");
  });

  it("skips a busy passer who is not in the cast this week", () => {
    const passer = chooseThrower([qb("backup"), qb("third")], {
      ...evidence,
      lately: new Map([["starter", 70], ["backup", 3]]),
    });

    expect(passer).toBe("backup");
  });

  it("falls back to the market when nobody dressed threw lately", () => {
    const passer = chooseThrower([qb("backup"), qb("third")], {
      ...evidence,
      lately: new Map([["starter", 70]]),
    });

    expect(passer).toBe("backup");
  });

  it("falls back to last season when the market priced nobody dressed", () => {
    const passer = chooseThrower([qb("third"), qb("rookie")], {
      ...evidence,
      lately: new Map([["starter", 70]]),
    });

    expect(passer).toBe("third");
  });

  it("does not hand the job to a receiver who threw a trick play", () => {
    const passer = chooseThrower(
      [qb("backup"), { playerId: "receiver", position: "WR" }],
      { ...evidence, lately: new Map([["starter", 70], ["receiver", 1]]) },
    );

    expect(passer).toBe("backup");
  });
});
