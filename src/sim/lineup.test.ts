import { describe, expect, it } from "vitest";
import { pickLineup, type LineupCandidate } from "./lineup.js";

function candidate(
  playerId: string,
  position: string,
  score: number,
): LineupCandidate {
  return { playerId, position, score };
}

describe("pickLineup", () => {
  it("fills required slots by score and gives flex to the best leftover", () => {
    const starters = pickLineup([
      candidate("qb1", "QB", 20),
      candidate("qb2", "QB", 25),
      candidate("rb1", "RB", 15),
      candidate("rb2", "RB", 14),
      candidate("rb3", "RB", 13),
      candidate("wr1", "WR", 12),
      candidate("wr2", "WR", 11),
      candidate("wr3", "WR", 5),
      candidate("te1", "TE", 8),
    ]);

    expect(starters).toContain("qb2");
    expect(starters).not.toContain("qb1");
    expect(starters).toContain("rb3");
    expect(starters).not.toContain("wr3");
    expect(starters).toHaveLength(7);
  });

  it("returns a short lineup when the roster cannot fill every slot", () => {
    const starters = pickLineup([
      candidate("qb1", "QB", 20),
      candidate("rb1", "RB", 15),
    ]);

    expect(starters).toEqual(["qb1", "rb1"]);
  });
});
