import { describe, expect, it } from "vitest";
import {
  pickLineup,
  startersNeeded,
  THREE_RECEIVER_FORMAT,
  TWO_RECEIVER_FORMAT,
  type LineupCandidate,
} from "./lineup.js";

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

describe("pickLineup in the three receiver format", () => {
  it("starts both good backs and gives the flex to the poor man left over", () => {
    const starters = pickLineup(
      [
        candidate("qb1", "QB", 19),
        candidate("qb2", "QB", 25),
        candidate("rb1", "RB", 18),
        candidate("rb2", "RB", 16),
        candidate("rb3", "RB", 2),
        candidate("wr1", "WR", 14),
        candidate("wr2", "WR", 12),
        candidate("wr3", "WR", 10),
        candidate("te1", "TE", 9),
      ],
      THREE_RECEIVER_FORMAT,
    );

    expect(starters).toHaveLength(startersNeeded(THREE_RECEIVER_FORMAT));
    expect(starters).toContain("rb1");
    expect(starters).toContain("rb2");
    expect(starters).toContain("wr3");
    // The spare quarterback outscores him, but only a back, receiver or
    // tight end can take the flex.
    expect(starters).toContain("rb3");
    expect(starters).not.toContain("qb1");
  });

  it("starts a man with no projection when nobody else covers his slot", () => {
    const starters = pickLineup(
      [
        candidate("qb1", "QB", 19),
        candidate("rb1", "RB", 18),
        candidate("rb2", "RB", 16),
        candidate("rb3", "RB", 5),
        candidate("wr1", "WR", 14),
        candidate("wr2", "WR", 12),
        candidate("wr3", "WR", 10),
        candidate("wr4", "WR", 8),
        candidate("teUnknown", "TE", 0),
      ],
      THREE_RECEIVER_FORMAT,
    );

    expect(starters).toContain("teUnknown");
    // The flex is the fourth receiver, not the man nobody has a number for.
    expect(starters).toContain("wr4");
    expect(starters).toHaveLength(startersNeeded(THREE_RECEIVER_FORMAT));
  });

  it("counts eight starters here and seven in the narrower format", () => {
    expect(startersNeeded(THREE_RECEIVER_FORMAT)).toBe(8);
    expect(startersNeeded(TWO_RECEIVER_FORMAT)).toBe(7);
  });
});
