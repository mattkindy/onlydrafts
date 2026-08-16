import { describe, expect, it } from "vitest";
import { scoringShare, scoringShareBasis, type RedZoneUse } from "./scoringShare.js";

const use = (over: Partial<RedZoneUse> = {}): RedZoneUse => ({
  redTargets: 0, redCarries: 0, goalCarries: 0, scores: 0,
  teamRedTargets: 40, teamRedCarries: 60, teamGoalCarries: 20, teamScores: 40,
  ...over,
});

describe("scoringShare", () => {
  it("gives a back his share of everything inside the twenty", () => {
    expect(scoringShare("RB", use({ redTargets: 10, redCarries: 30 })))
      .toBeCloseTo(40 / 100);
  });

  it("gives a tight end his share of the targets there", () => {
    expect(scoringShare("TE", use({ redTargets: 12 }))).toBeCloseTo(12 / 40);
  });

  it("leaves a receiver on what he actually scored", () => {
    expect(scoringShare("WR", use({ scores: 8, redTargets: 30 }))).toBeCloseTo(8 / 40);
  });

  it("does not let a lucky back look like a workhorse", () => {
    const lucky = use({ scores: 8, redCarries: 2 });
    const worked = use({ scores: 2, redCarries: 30 });

    expect(scoringShare("RB", worked)).toBeGreaterThan(scoringShare("RB", lucky));
  });

  it("returns nothing rather than dividing by nothing", () => {
    const empty = { ...use(), teamRedTargets: 0, teamRedCarries: 0, teamScores: 0 };

    expect(scoringShare("RB", empty)).toBe(0);
    expect(scoringShare("WR", empty)).toBe(0);
    expect(scoringShare("TE", empty)).toBe(0);
  });

  it("says which measure it used", () => {
    expect(scoringShareBasis("RB")).toContain("inside the twenty");
    expect(scoringShareBasis("WR")).toContain("touchdowns");
  });
});
