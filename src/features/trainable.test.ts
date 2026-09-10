import { describe, expect, it } from "vitest";
import { trainingComplaint } from "./trainable.js";
import type { SeasonExample } from "./seasonModel.js";
import { noParts } from "./boardSource.js";

/** one man's season, with every part at the level given */
function example(level: number): SeasonExample {
  const parts = noParts();
  const was = noParts();

  for (const part of Object.keys(parts) as (keyof typeof parts)[]) {
    parts[part] = level;
    was[part] = level;
  }

  return {
    playerId: "00-0000001",
    position: "WR",
    prevPpg: 12,
    actualPpg: 13,
    prevParts: was,
    actualParts: parts,
    moved: false,
    group: "WR",
    rookieCapital: 0,
    snapPct: 0.7,
    gamesPrev: 16,
    tdPointShare: 0.2,
    olRetention: 0.6,
    ocChanged: false,
    hcChanged: false,
  } as unknown as SeasonExample;
}

function many(level: number, howMany: number): SeasonExample[] {
  return Array.from({ length: howMany }, () => example(level));
}

describe("trainingComplaint", () => {
  it("says nothing when every part has rows", () => {
    const bySeason = new Map([[2024, 40]]);
    expect(trainingComplaint(many(5, 40), bySeason)).toBeUndefined();
  });

  it("names the seasons when no season produced a row", () => {
    const complaint = trainingComplaint([], new Map([[2023, 0], [2024, 0]]));
    expect(complaint).toContain("no training rows");
    expect(complaint).toContain("2023: 0");
    expect(complaint).toContain("stats_player_week_<season>.csv");
  });

  it("names the parts that came out empty", () => {
    const rows = many(5, 40).map((e) => ({
      ...e,
      prevParts: { ...e.prevParts!, interceptions: 0 },
      actualParts: { ...e.actualParts!, interceptions: 0 },
    }));
    const complaint = trainingComplaint(rows, new Map([[2024, 40]]));
    expect(complaint).toContain("interceptions (0)");
    expect(complaint).toContain("2024: 40");
  });

  it("complains when a part has rows but too few to fit", () => {
    const complaint = trainingComplaint(many(5, 3), new Map([[2024, 3]]));
    expect(complaint).toContain("too few");
  });
});
