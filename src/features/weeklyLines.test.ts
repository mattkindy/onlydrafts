import { describe, expect, it } from "vitest";
import { chancesFrom, weeklyLines, type WeeklyScore } from "./weeklyLines.js";

/** one week of a small league: scores fall by a point down each position */
const week = (top: number): WeeklyScore[] =>
  ["QB", "RB", "WR", "TE"].flatMap((position) =>
    Array.from({ length: 60 }, (_, i) => ({ position, points: top - i })),
  );

describe("the lines a week is measured against", () => {
  const lines = weeklyLines([week(40), week(40), week(40)]);

  it("puts the boom line at the fifth best passer and the twelfth best back", () => {
    expect(lines.boom["QB"]).toBe(36);
    expect(lines.boom["TE"]).toBe(36);
    expect(lines.boom["RB"]).toBe(29);
    expect(lines.boom["WR"]).toBe(29);
  });

  it("puts the bust line under everyone a twelve team league starts", () => {
    // twelve passers start, so the thirteenth best is replacement
    expect(lines.bust["QB"]).toBe(28);
    // backs and receivers also fill the flex, so more of them start
    expect(lines.bust["RB"]).toBeLessThan(lines.bust["QB"]!);
  });

  it("counts the runs that cleared each line", () => {
    const said = chancesFrom([10, 30, 37, 40], lines, "QB")!;

    expect(said.boomChance).toBe(0.5);
    expect(said.bustChance).toBe(0.25);
  });

  it("says nothing for a position nobody scored", () => {
    expect(chancesFrom([10], lines, "K")).toBeUndefined();
    expect(chancesFrom([], lines, "QB")).toBeUndefined();
  });
});
