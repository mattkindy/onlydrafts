import { describe, expect, it } from "vitest";

import { readOf } from "./playerRead.ts";

const work = (snaps: number) => ({ games: 3, snaps, carries: 0, targets: 0, redZone: 0 });
const says = (input: Parameters<typeof readOf>[0]) => readOf(input).map((c) => c.says);

describe("the read on a player", () => {
  it("says a run over or under his line, and a mixed one as a count", () => {
    const base = { next: [], work: null };

    expect(says({ ...base, played: [
      { got: 20, pts: 15 }, { got: 18, pts: 15 }, { got: 30, pts: 15 },
    ] })).toEqual(["3 straight over proj"]);
    expect(says({ ...base, played: [
      { got: 10, pts: 15 }, { got: 12, pts: 15 }, { got: 9, pts: 15 },
    ] })).toEqual(["3 straight under proj"]);
    expect(says({ ...base, played: [
      { got: 20, pts: 15 }, { got: null, pts: 15 }, { got: 9, pts: 15 }, { got: 16, pts: 15 },
    ] })).toEqual(["2 of last 3 over proj"]);
  });

  it("says the weeks he has missed most lately, first", () => {
    const played = [
      { got: 20, pts: 15 }, { got: 12, pts: 15 }, { got: 10, pts: 15 },
      { got: null, pts: 15 }, { got: null, pts: 15 },
    ];

    expect(says({ played, next: [], work: null }))
      .toEqual(["out last 2 weeks", "1 of last 3 over proj"]);
    expect(says({ played: played.slice(0, 4), next: [], work: null })[0]).toBe("out last week");
  });

  it("says a role moving by a starter's worth of snaps, and holding otherwise", () => {
    const base = { played: [], next: [] };

    expect(says({ ...base, work: { recent: work(71), before: work(42) } }))
      .toEqual(["snaps up 42→71%"]);
    expect(says({ ...base, work: { recent: work(55), before: work(90) } }))
      .toEqual(["snaps down 90→55%"]);
    expect(says({ ...base, work: { recent: work(97), before: work(95) } }))
      .toEqual(["snaps steady 97%"]);
  });

  it("says the weeks ahead only when they sit well off his average", () => {
    const base = { played: [], work: null, ppg: 15 };

    expect(says({ ...base, next: [17, 18, 16.5] })).toEqual(["easier run ahead"]);
    expect(says({ ...base, next: [12, 13, 13.5] })).toEqual(["tougher run ahead"]);
    expect(says({ ...base, next: [15, 15.5, 14.5] })).toEqual([]);
  });

  it("says his draft spot when he is well clear of it either way", () => {
    const base = { played: [], next: [], work: null };

    expect(says({ ...base, claim: 1.5 })).toEqual(["+1.5/g over draft spot"]);
    expect(says({ ...base, claim: -1.4 })).toEqual(["-1.4/g under draft spot"]);
    expect(says({ ...base, claim: 0.2 })).toEqual([]);
  });
});
