/**
 * The work a player had, read off the weeks the board ships.
 */

import { describe, expect, it } from "vitest";

import type { Player } from "./scoring.ts";
import { workOf, workWords } from "./usage.ts";

type Use = [number, number, number, number];

const aBack = (uses: (Use | null)[]): Player => ({
  name: "a back", key: "aback", position: "RB",
  weeks: uses.map((use, i) => ({
    w: i + 1, opp: "v NE", of: 1, ...(use ? { use } : {}),
  })),
}) as Player;

describe("a player's work", () => {
  it("is nothing for a player with no game counted", () => {
    expect(workOf(aBack([null, null]))).toBeNull();
    expect(workWords(aBack([]))).toBe("");
  });

  it("averages his latest three games apart from the rest", () => {
    const work = workOf(aBack([
      [40, 6, 1, 0], [44, 8, 2, 1], null,
      [70, 15, 3, 2], [74, 17, 4, 3], [72, 16, 2, 1],
    ]))!;

    expect(work.recent.games).toBe(3);
    expect(work.recent.snaps).toBeCloseTo(72, 10);
    expect(work.recent.carries).toBeCloseTo(16, 10);
    expect(work.before!.snaps).toBeCloseTo(42, 10);
    expect(work.season.games).toBe(5);
  });

  /**
   * A back who took the job in week 4 reads like one who has always had
   * it unless the move is said, and the move is the news.
   */
  it("says when his role moved", () => {
    expect(workWords(aBack([
      [40, 6, 1, 0], [44, 8, 2, 0],
      [70, 15, 3, 2], [74, 17, 4, 3], [72, 16, 2, 1],
    ]))).toBe("72% snaps, up from 42%, 19.0 touches, 2.0 in the 20");
  });

  it("leaves a steady role as it is", () => {
    expect(workWords(aBack([
      [60, 10, 3, 0], [62, 11, 2, 0], [58, 9, 4, 0], [61, 10, 3, 0],
    ]))).toBe("60% snaps, 13.0 touches");
  });
});
