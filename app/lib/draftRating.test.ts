import { describe, expect, it } from "vitest";
import {
  fillLineup, marketBar, marketCurve, ratePicks, rateTeams, worthAt, worthOf,
} from "./draftRating.ts";
import type { Player } from "./scoring.ts";

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
 * The bar a pick is judged against used to be the smoothed curve read
 * at the pick number, which charged a team for owning an early pick.
 * At the third pick the best man left is priced about third, so the
 * ceiling is nothing and any deviation is a loss on the steepest part
 * of the curve. At the hundredth a man can fall eighty places.
 */
describe("what a pick at each place actually buys", () => {
  const men: Player[] = Array.from({ length: 200 }, (_, i) => ({
    name: `p${i}`,
    key: `p${i}`,
    position: ["RB", "WR", "TE", "QB"][i % 4]!,
    adp: i + 1,
    adpHigh: Math.max(1, i - 4),
    adpLow: i + 8,
    vor: Math.max(0, 240 - i * 1.4),
  }) as Player);

  it("falls away down the board, the way the curve does", () => {
    const bar = marketBar(men, 150, [], 40);

    expect(bar[0]!).toBeGreaterThan(bar[40]!);
    expect(bar[40]!).toBeGreaterThan(bar[120]!);
  });

  /**
   * A keeper takes a slot without taking anybody off the board, so by
   * the twentieth pick the room has chosen fewer than twenty times.
   * Leaving that out ran the pool down too fast and turned every pick
   * in the draft into a bargain.
   */
  it("counts a keeper's slot as spending no one", () => {
    const plain = marketBar(men, 150, [], 40);
    const withKeepers = marketBar(
      men,
      150,
      Array.from({ length: 20 }, (_, i) => ({ key: `p${i}`, at: i * 3 + 1 })),
      40,
    );

    /**
     * The two effects cancel when the kept men are the good ones and
     * their slots are spread through the draft: twenty fewer men on the
     * board and twenty fewer choices made, so the sixtieth pick buys
     * about what it did. What must not happen is the pool running down
     * twice as fast, which is what the bug did.
     */
    expect(Math.abs(withKeepers[60]! - plain[60]!)).toBeLessThan(5);
    expect(withKeepers[60]!).toBeGreaterThan(plain[120]! + 20);
  });
});
