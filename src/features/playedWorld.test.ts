import { describe, expect, it } from "vitest";
import { mergeWeekStatus } from "../data/injuries.js";
import { chooseThrower, onTheRoster } from "./playedWorld.js";
import { rosterWeekFor } from "./rosterWeek.js";

describe("rosterWeekFor", () => {
  it("reads the week asked for when the file has it", () => {
    expect(rosterWeekFor([1, 2, 3], 2)).toBe(2);
  });

  it("reads the latest week before it when the file stops short", () => {
    expect(rosterWeekFor([1, 1, 2, 2], 3)).toBe(2);
  });
});

describe("onTheRoster", () => {
  it("keeps the active players in August and in season", () => {
    expect(onTheRoster("ACT", false)).toBe(true);
    expect(onTheRoster("ACT", true)).toBe(true);
  });

  it("keeps a game day inactive in August only", () => {
    expect(onTheRoster("INA", false)).toBe(true);
    expect(onTheRoster("INA", true)).toBe(false);
  });

  it("leaves out reserve, cut, retired and practice squad players", () => {
    for (const status of ["RES", "CUT", "RET", "DEV", "EXE"]) {
      expect(onTheRoster(status, false)).toBe(false);
    }
  });
});

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

describe("a quarterback Sleeper has as Doubtful before the final report", () => {
  const roster = [
    { playerId: "williams", position: "QB", status: "ACT" },
    { playerId: "bagent", position: "QB", status: "ACT" },
    { playerId: "keenum", position: "QB", status: "ACT" },
  ];
  const evidence = {
    lately: new Map([["williams", 60], ["bagent", 9]]),
    adpOf: (playerId: string) => (playerId === "williams" ? 30 : undefined),
    threwLastYear: new Map([["williams", 686], ["bagent", 4]]),
  };

  // the same test the live walk puts each roster row through
  const castOf = (calls: ReturnType<typeof mergeWeekStatus>) =>
    roster.filter((row) =>
      !calls.get(row.playerId)?.out && onTheRoster(row.status, true));

  it("leaves the cast, so the backup throws", () => {
    const calls = mergeWeekStatus(2026, 3, new Map(), [{
      season: 2026, week: 3, gsisId: "williams", team: "CHI",
      status: "Doubtful", fetchedAt: "2026-09-23T11:20:00Z",
    }]);
    const cast = castOf(calls);

    expect(cast.map((p) => p.playerId)).toEqual(["bagent", "keenum"]);
    expect(chooseThrower(cast, evidence)).toBe("bagent");
  });

  it("keeps his job when the snapshot is for another week", () => {
    const calls = mergeWeekStatus(2026, 3, new Map(), [{
      season: 2026, week: 2, gsisId: "williams", team: "CHI",
      status: "Doubtful", fetchedAt: "2026-09-16T11:20:00Z",
    }]);

    expect(chooseThrower(castOf(calls), evidence)).toBe("williams");
  });
});
