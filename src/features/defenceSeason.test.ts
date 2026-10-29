/**
 * A defence's level: last season pulled toward the middle, then this
 * season taking more of it with every game.
 */

import { describe, expect, it } from "vitest";

import {
  defenceLevel, leagueParts, SEASON_HALF_GAMES, TOWARD_THE_MIDDLE,
} from "./defenceSeason.js";

const LEAGUE = { sack: 2.4, int: 0.7, pts_allow_14_20: 0.3 };
const LAST = { sack: 3.4, int: 1.1, pts_allow_14_20: 0.5 };
const NOW = { sack: 1.0, int: 0.2, pts_allow_14_20: 0.1 };

describe("a defence's level", () => {
  it("is last season half way to the middle before a game is played", () => {
    const level = defenceLevel(LAST, LEAGUE, {}, 0);

    expect(TOWARD_THE_MIDDLE).toBe(0.5);
    expect(level["sack"]).toBeCloseTo(2.9, 10);
    expect(level["int"]).toBeCloseTo(0.9, 10);
    expect(level["pts_allow_14_20"]).toBeCloseTo(0.4, 10);
  });

  it("gives this season half the weight once it has played the half games", () => {
    const level = defenceLevel(LAST, LEAGUE, NOW, SEASON_HALF_GAMES);

    expect(level["sack"]).toBeCloseTo((2.9 + 1.0) / 2, 10);
  });

  it("moves toward this season as the games come in", () => {
    const sacks = [0, 3, 7, 12].map((games) =>
      defenceLevel(LAST, LEAGUE, NOW, games)["sack"]!);

    expect(sacks).toEqual([...sacks].sort((a, b) => b - a));
    expect(sacks[3]).toBeGreaterThan(NOW.sack);
  });

  it("averages the league's defences part by part", () => {
    expect(leagueParts([{ sack: 2, int: 1 }, { sack: 4 }]))
      .toEqual({ sack: 3, int: 0.5 });
  });
});
