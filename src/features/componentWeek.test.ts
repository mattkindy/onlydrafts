import { describe, expect, it } from "vitest";
import {
  blendWithComponent, componentWeight,
  COMPONENT_FADE_FROM_WEEK, COMPONENT_FADE_TO_WEEK,
} from "./componentWeek.js";

describe("componentWeight", () => {
  it("is 0 for every played week now that the fade is off", () => {
    expect(COMPONENT_FADE_FROM_WEEK).toBe(0);
    expect(COMPONENT_FADE_TO_WEEK).toBe(0);

    for (let week = 1; week < 10; week++) {
      expect(componentWeight(week)).toBe(0);
    }
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
  it("returns the season anchor for every played week now that the fade is off", () => {
    expect(blendWithComponent(1, 12, 5)).toBe(5);
    expect(blendWithComponent(8, 12, 5)).toBe(5);
  });

  it("falls back to the anchor with no component line to blend in", () => {
    expect(blendWithComponent(1, undefined, 5)).toBe(5);
  });
});
