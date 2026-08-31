import { describe, expect, it } from "vitest";
import {
  fillLineup, marketCurve, ratePicks, rateTeams, worthAt, worthOf,
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
  it("leans on the room, so a cheap man our numbers love is not a steal", () => {
    const curve = marketCurve(board);
    const loved = man("loved", "RB", 100, 118);
    const priced = man("priced", "RB", 2, 118);
    expect(worthOf(priced, curve)).toBeGreaterThan(worthOf(loved, curve));
  });

  it("judges a man nobody priced on our numbers alone", () => {
    const curve = marketCurve(board);
    expect(worthOf(man("nobody", "RB", null, 42), curve)).toBe(42);
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
  it("says how long a man lasted past where the room had him", () => {
    const curve = marketCurve(board);
    const [waited, reached] = ratePicks(
      [{ at: 40, p: board[9]! }, { at: 10, p: board[59]! }], curve,
    );
    expect(waited!.waited).toBe(-30);
    expect(reached!.waited).toBe(50);
  });

  it("leaves a man nobody priced without a verdict on waiting", () => {
    const curve = marketCurve(board);
    const [only] = ratePicks([{ at: 90, p: man("free", "K", null, 0) }], curve);
    expect(only!.waited).toBeNull();
  });
});
