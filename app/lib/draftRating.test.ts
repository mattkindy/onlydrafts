import { describe, expect, it } from "vitest";
import {
  barFromPicks, fillLineup, keyForPick, marketCurve, ratePicks, rateTeams,
  worthAt, worthOf,
} from "./draftRating.ts";
import type { Player } from "./scoring.ts";
import { normalizeName } from "./store.ts";

const man = (
  name: string, position: string, adp: number | null, vor: number,
): Player => ({
  name, key: name.toLowerCase(), position, team: "ANY",
  adp, vor, ppg: 0,
} as unknown as Player);

/** a board where the room and the numbers agree, best first */
const board = Array.from({ length: 120 }, (_, i) =>
  man(`man${i + 1}`, ["RB", "WR", "TE", "QB"][i % 4]!, i + 1, 120 - i));

const SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX"];

describe("the market curve", () => {
  it("falls away as the room gets later, since early picks buy more", () => {
    const curve = marketCurve(board);
    expect(worthAt(curve, 1)).toBeGreaterThan(worthAt(curve, 60));
    expect(worthAt(curve, 60)).toBeGreaterThan(worthAt(curve, 119));
  });

  it("answers past its end rather than saying nothing", () => {
    const curve = marketCurve(board);
    expect(worthAt(curve, 999)).toBe(worthAt(curve, board.length));
  });

  it("says nothing when nobody is priced", () => {
    expect(worthAt(marketCurve([man("a", "RB", null, 9)]), 1)).toBe(0);
  });
});

describe("what a man is worth", () => {
  it("goes on where he is drafted, not on what we think of him", () => {
    const curve = marketCurve(board);
    // our own numbers adore him, the market does not, and the market wins
    const loved = man("loved", "RB", 100, 118);
    const priced = man("priced", "RB", 2, 118);
    expect(worthOf(priced, curve)).toBeGreaterThan(worthOf(loved, curve));
  });

  it("prices a man nobody drafted at the bottom of the curve", () => {
    const curve = marketCurve(board);
    expect(worthOf(man("nobody", "RB", null, 42), curve))
      .toBe(worthAt(curve, curve.length));
  });
});

describe("filling a lineup", () => {
  it("starts only what the league starts and benches the rest", () => {
    const curve = marketCurve(board);
    const five = ["RB", "RB", "RB", "RB", "RB"].map((pos, i) =>
      man(`back${i}`, pos, i + 1, 50 - i));
    const filled = fillLineup(five, SLOTS, curve);
    const asBacks = filled.starters.filter((s) => s.slot === "RB");
    expect(asBacks).toHaveLength(2);
    // the third back can take the flex, the last two sit
    expect(filled.starters.filter((s) => s.slot === "FLEX")).toHaveLength(1);
    expect(filled.bench).toHaveLength(2);
  });

  it("counts a bench man for less than a starter", () => {
    const curve = marketCurve(board);
    const one = fillLineup([man("a", "RB", 1, 50)], SLOTS, curve);
    const two = fillLineup(
      [man("a", "RB", 1, 50), man("b", "RB", 2, 50), man("c", "RB", 3, 50),
       man("d", "RB", 4, 50)],
      SLOTS, curve,
    );
    const each = (two.worth - one.worth) / 3;
    expect(each).toBeLessThan(worthOf(man("a", "RB", 1, 50), curve));
  });
});

describe("rating teams", () => {
  it("does not reward a team for drafting first", () => {
    const curve = marketCurve(board);
    const at = (picks: number[]) => ({
      owner: `t${picks[0]}`,
      took: picks.map((n) => ({ at: n, p: board[n - 1]! })),
    });
    // both take exactly the men the room says go at their slots
    const rated = rateTeams([at([1, 24, 25]), at([12, 13, 36])], SLOTS, curve);

    for (const team of rated) {
      expect(Math.abs(team.over)).toBeLessThan(6);
    }
  });

  it("puts the team that beat the room on top", () => {
    const curve = marketCurve(board);
    const asExpected = {
      owner: "even",
      took: [{ at: 40, p: board[39]! }, { at: 41, p: board[40]! }],
    };
    // the same slots, but it came away with two of the best men
    const stole = {
      owner: "stole",
      took: [{ at: 40, p: board[0]! }, { at: 41, p: board[1]! }],
    };
    const rated = rateTeams([asExpected, stole], SLOTS, curve);
    expect(rated[0]!.owner).toBe("stole");
    expect(rated[0]!.over).toBeGreaterThan(rated[1]!.over);
  });
});

describe("rating one draft's picks", () => {
  it("says how far a man fell past ADP, and a minus means you reached", () => {
    const curve = marketCurve(board);
    const [fell, reached] = ratePicks(
      [{ at: 40, p: board[9]! }, { at: 10, p: board[59]! }], curve,
    );
    // ADP had him 10th and he lasted to 40
    expect(fell!.fell).toBe(30);
    // ADP had him 60th and you took him at 10
    expect(reached!.fell).toBe(-50);
  });

  it("leaves a man nobody priced without a verdict on falling", () => {
    const curve = marketCurve(board);
    const [only] = ratePicks([{ at: 90, p: man("free", "K", null, 0) }], curve);
    expect(only!.fell).toBeNull();
  });
});


/**
 * The bar was the smoothed curve read at the pick number, and it
 * charged a team for owning an early pick: at the third pick the best
 * man left is priced about third, so the ceiling is nothing, while at
 * the hundredth a man can fall eighty places. Over one real draft that
 * read minus 6.3 a pick in the first two rounds against plus 5.2 in
 * the middle. The bar now comes from what the room paid at each slot.
 */
describe("what a pick at each place bought", () => {
  const curve = marketCurve(board);
  /** a room that took the men the market said, slot for slot */
  const asExpected = Array.from({ length: 110 }, (_, i) =>
    ({ at: i + 1, p: board[i]! }));

  it("falls away down the board, the way the curve does", () => {
    const bar = barFromPicks(asExpected, curve, 110);

    expect(bar[0]!).toBeGreaterThan(bar[50]!);
    expect(bar[50]!).toBeGreaterThan(bar[100]!);
  });

  /**
   * A window either side of an early pick reaches down the steep part
   * of the curve and has nothing above it, so its average lands far
   * below the truth. Taking the average handed the first two rounds
   * thirteen points of surplus that nobody had earned.
   */
  it("fits a line through the window rather than averaging it", () => {
    const bar = barFromPicks(asExpected, curve, 110);

    expect(bar[2]!).toBeGreaterThan(worthAt(curve, 3) * 0.85);
  });

  it("leaves a team that drafted to the room at about nothing", () => {
    const bar = barFromPicks(asExpected, curve, 110);
    const rated = rateTeams(
      [{
        owner: "even",
        took: [4, 28, 40, 64, 88].map((n) => ({ at: n, p: board[n - 1]! })),
      }],
      SLOTS,
      curve,
      (pick) => bar[Math.max(0, pick - 1)] ?? 0,
    );

    expect(Math.abs(rated[0]!.perPick)).toBeLessThan(6);
  });
});

/**
 * A man kept costs the pick he is kept at and is nearly always cheaper
 * than one drafted there, so measuring both against one bar made
 * keeping look good for every side and drafting look bad for nine of
 * twelve. The bar is asked about the slot and about which it was.
 */
describe("keeping and drafting are different markets", () => {
  const curve = marketCurve(board);

  it("asks the bar which kind of pick it was", () => {
    const asked: { pick: number; kept: boolean }[] = [];
    const took = [
      { at: 10, p: board[9]!, kept: true },
      { at: 40, p: board[39]!, kept: false },
    ];

    rateTeams([{ owner: "one", took }], SLOTS, curve, (pick, kept) => {
      asked.push({ pick, kept });

      return worthAt(curve, pick);
    });

    expect(asked).toContainEqual({ pick: 10, kept: true });
    expect(asked).toContainEqual({ pick: 40, kept: false });
  });

  it("prices the same slot differently for the two", () => {
    const dear = (pick: number, kept: boolean) =>
      kept ? worthAt(curve, pick) * 2 : worthAt(curve, pick);
    const took = [{ at: 10, p: board[9]!, kept: true }];

    const cheap = rateTeams(
      [{ owner: "a", took }], SLOTS, curve, () => 0,
    )[0]!;
    const costly = rateTeams(
      [{ owner: "a", took }], SLOTS, curve, dear,
    )[0]!;

    expect(costly.over).toBeLessThan(cheap.over);
  });
});

describe("finding a provider's pick on the board", () => {
  const key = (name: string, position = "WR", team: string | null = "ANY") =>
    keyForPick({ name, position, team }, normalizeName);

  it("drops accents, suffixes and punctuation", () => {
    expect(key("Audric Estimé")).toBe("audricestime");
    expect(key("Brian Thomas Jr.")).toBe("brianthomas");
    expect(key("D'Andre Swift")).toBe("dandreswift");
  });

  it("knows the spellings the providers use for a man the board spells another way", () => {
    expect(key("Joshua Palmer")).toBe("joshpalmer");
    expect(key("Hollywood Brown")).toBe("marquisebrown");
    expect(key("Zonovan Knight", "RB")).toBe("bamknight");
  });

  it("looks a defence up by its team, in the board's letters", () => {
    expect(key("Los Angeles Rams", "DEF", "LAR")).toBe("la");
    expect(key("Steelers D/ST", "DEF", "PIT")).toBe("pit");
  });
});
