import { describe, expect, it } from "vitest";
import { LINE_COLUMNS, linesFromCache } from "./liveLines.js";

describe("a week's cached lines", () => {
  const text = [
    LINE_COLUMNS.join(","),
    "2024,9,00-0001,RB,KC,LV,11.5,13.5,12.5,4.2,8.35,17.1,21.8",
    "2024,9,00-0002,WR,LV,KC,9.25,,9.25,2.1,5.68,13.4,18.2",
  ].join("\n");
  const lines = linesFromCache(text);

  it("puts the blend in the middle of the five figures", () => {
    expect(lines[0]!.five).toEqual([4.2, 8.35, 12.5, 17.1, 21.8]);
  });

  it("leaves a man Sleeper never priced without a number", () => {
    expect(lines[1]!.sleeper).toBeNull();
    expect(lines[1]!.blend).toBe(9.25);
  });

  it("keeps the two sides of his game", () => {
    expect(lines[0]!.team).toBe("KC");
    expect(lines[0]!.opponent).toBe("LV");
    expect(lines[0]!.position).toBe("RB");
  });
});
