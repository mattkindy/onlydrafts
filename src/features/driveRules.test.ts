import { describe, expect, it } from "vitest";
import { rulesFrom } from "./driveRules.js";

/** one first and ten, of a kind, made from a spot, gaining what it gained */
const snaps = (count: number, yardline: number, yards: number) =>
  Array.from({ length: count }, () => ({
    offense: "NE", playType: "pass", down: "1", togo: "10",
    yardline: String(yardline), yards: String(yards), turnover: "0",
  }));

/** every draw the pool can make, walked in order rather than sampled */
const everyDraw = (draw: (uniform: () => number) => number, times = 200) =>
  new Set(Array.from({ length: times }, (_, i) => draw(() => i / times)));

describe("what a snap on the fifteen may borrow", () => {
  // twenty plays from the fifteen, thirty from the eighteen, and fifty
  // from the twelve, whose gains the goal line had already cut off
  const rows = [
    ...snaps(20, 15, 6), ...snaps(30, 18, 9), ...snaps(50, 12, 3),
  ];

  it("leaves out the plays made nearer the goal", () => {
    const drawn = everyDraw(
      (uniform) => rulesFrom(rows).yardsFor("pass", 1, 10, 15, uniform),
    );

    expect(drawn).toEqual(new Set([6, 9]));
  });

  it("takes them back where there is nothing else to draw", () => {
    const drawn = everyDraw(
      (uniform) => rulesFrom(snaps(50, 12, 3)).yardsFor("pass", 1, 10, 15, uniform),
    );

    expect(drawn).toEqual(new Set([3]));
  });

  it("still draws from the spot itself", () => {
    const drawn = everyDraw(
      (uniform) => rulesFrom(snaps(50, 15, 6)).yardsFor("pass", 1, 10, 15, uniform),
    );

    expect(drawn).toEqual(new Set([6]));
  });
});
