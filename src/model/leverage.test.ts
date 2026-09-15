import { describe, expect, it } from "vitest";
import { leverageWeight, type PlayState } from "./leverage.js";

const state = (over: Partial<PlayState> = {}): PlayState =>
  ({ margin: 0, secondsLeft: 1800, ...over });

describe("leverageWeight, off the win probability", () => {
  it("counts a coin flip in full", () => {
    expect(leverageWeight(state({ winProbability: 0.5 }), "doubt")).toBe(1);
  });

  it("gives a nine in ten favourite about a third of a play", () => {
    expect(leverageWeight(state({ winProbability: 0.9 }), "doubt"))
      .toBeCloseTo(0.36);
  });

  it("treats the two sides of a lopsided game alike", () => {
    const ahead = leverageWeight(state({ winProbability: 0.95 }), "doubt");
    const behind = leverageWeight(state({ winProbability: 0.05 }), "doubt");

    expect(ahead).toBeCloseTo(behind);
    expect(ahead).toBeCloseTo(0.19);
  });

  it("reads the scoreboard when the play file has no probability", () => {
    const gone = state({ margin: -24, secondsLeft: 600 });

    expect(leverageWeight(gone, "doubt")).toBe(leverageWeight(gone, "margin"));
  });
});

describe("leverageWeight, off the score and the clock", () => {
  const q4 = (margin: number) =>
    leverageWeight(state({ margin, secondsLeft: 900 }), "margin");

  it("counts a tie game in full whenever it happens", () => {
    expect(q4(0)).toBe(1);
    expect(leverageWeight(state({ margin: 0, secondsLeft: 3600 }), "margin"))
      .toBe(1);
  });

  it("still counts a fourth quarter margin of nine in full", () => {
    expect(q4(9)).toBe(1);
    expect(q4(-9)).toBe(1);
  });

  it("drops a fourth quarter margin of seventeen to nothing", () => {
    expect(q4(17)).toBe(0);
    expect(q4(-21)).toBe(0);
  });

  it("puts the halfway point of that range in the middle", () => {
    expect(q4(13)).toBeCloseTo(0.5);
  });

  it("needs twice the margin at kickoff to say the same thing", () => {
    const kickoff = (margin: number) =>
      leverageWeight(state({ margin, secondsLeft: 3600 }), "margin");

    expect(kickoff(18)).toBe(1);
    expect(kickoff(34)).toBe(0);
  });

  it("holds a tight overtime at full rather than at nothing", () => {
    expect(leverageWeight(state({ margin: 3, secondsLeft: 0 }), "margin"))
      .toBe(1);
  });

  it("never leaves the unit range", () => {
    for (const margin of [-60, -17, -3, 0, 7, 28, 60]) {
      for (const secondsLeft of [0, 120, 900, 2400, 3600]) {
        const weight = leverageWeight(state({ margin, secondsLeft }), "margin");

        expect(weight).toBeGreaterThanOrEqual(0);
        expect(weight).toBeLessThanOrEqual(1);
      }
    }
  });
});
