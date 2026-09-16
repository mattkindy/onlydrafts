import { describe, expect, it } from "vitest";
import {
  blendWithComponent, componentWeight,
  COMPONENT_FADE_FROM_WEEK, COMPONENT_FADE_TO_WEEK,
} from "./componentWeek.js";

describe("componentWeight", () => {
  it("holds at 1 through the start of the fade", () => {
    expect(componentWeight(1)).toBe(1);
    expect(componentWeight(COMPONENT_FADE_FROM_WEEK)).toBe(1);
  });

  it("holds at 0 from the end of the fade on", () => {
    expect(componentWeight(COMPONENT_FADE_TO_WEEK)).toBe(0);
    expect(componentWeight(COMPONENT_FADE_TO_WEEK + 2)).toBe(0);
  });

  it("falls in a straight line in between", () => {
    const midway = (COMPONENT_FADE_FROM_WEEK + COMPONENT_FADE_TO_WEEK) / 2;
    expect(componentWeight(midway)).toBeCloseTo(0.5, 6);
  });

  it("never rises as the week goes up", () => {
    for (let week = 1; week < 8; week++) {
      expect(componentWeight(week + 1)).toBeLessThanOrEqual(
        componentWeight(week),
      );
    }
  });
});

describe("blendWithComponent", () => {
  it("is exactly the component line at week 1", () => {
    expect(blendWithComponent(1, 12, 5)).toBe(12);
  });

  it("is exactly the season anchor from the end of the fade on", () => {
    expect(blendWithComponent(COMPONENT_FADE_TO_WEEK, 12, 5)).toBe(5);
    expect(blendWithComponent(COMPONENT_FADE_TO_WEEK + 3, 12, 5)).toBe(5);
  });

  it("falls back to the anchor with no component line to blend in", () => {
    expect(blendWithComponent(1, undefined, 5)).toBe(5);
  });
});
