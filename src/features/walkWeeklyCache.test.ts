import { describe, expect, it } from "vitest";
import {
  parseWalkRows,
  walkKey,
  walkRowsToCsv,
  type WalkWeekRow,
} from "./walkWeeklyCache.js";

const rows: WalkWeekRow[] = [
  {
    season: 2025,
    week: 7,
    playerId: "00-0034796",
    position: "RB",
    points: 13.4567,
    touches: 18.25,
    tds: 0.6,
    dealt: [4.2, 11.7, 24.45],
  },
];

describe("the walk's weekly cache", () => {
  it("reads back what it wrote", () => {
    const back = parseWalkRows(walkRowsToCsv(rows));
    expect(back.get(walkKey(2025, 7, "00-0034796"))).toEqual(rows[0]);
  });

  it("has nothing for a week nobody played", () => {
    const back = parseWalkRows(walkRowsToCsv(rows));
    expect(back.has(walkKey(2025, 8, "00-0034796"))).toBe(false);
  });
});
