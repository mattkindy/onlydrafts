import { describe, expect, it } from "vitest";
import { seededRng } from "../sim/rng.js";
import { normalDraw } from "../sim/normal.js";
import { presets } from "../scoring/fantasyPoints.js";
import { DEFAULT_SEASON, simulateSeason } from "./seasonSim.js";
import { LEAGUE_PLAYS, type SituationalRole } from "./situationalWeek.js";
import type { Draws } from "./playerWeek.js";

const drawsFrom = (seed: number): Draws => {
  const rng = seededRng(seed);
  return { uniform: rng, normal: () => normalDraw(rng) };
};

const TEAM = { plays: LEAGUE_PLAYS, passShare: 0.54 };
const SETTINGS = { ...DEFAULT_SEASON, runs: 300, scoring: presets.standard };

function back(id: string, over: Partial<SituationalRole> = {}): SituationalRole {
  return {
    playerId: id, position: "RB",
    shareIn: { openField: 0.28, thirdAndShort: 0.35, thirdAndLong: 0.08, nearGoal: 0.3 },
    finishIn: { openField: 0.01, thirdAndShort: 0.04, thirdAndLong: 0.02, nearGoal: 0.12 },
    yardsPerTouch: { openField: 4.4, thirdAndShort: 3.0, thirdAndLong: 6.5, nearGoal: 2.2 },
    catchRate: 0.72, availability: 1,
    ...over,
  };
}

const run = (roster: SituationalRole[], settings = SETTINGS, seed = 6) =>
  simulateSeason(TEAM, roster, settings, drawsFrom(seed));

describe("simulateSeason", () => {
  it("spreads one week much wider than a season average", () => {
    const [player] = run([back("a")]);
    const week = player!.weekly.p90 - player!.weekly.p10;
    const average = player!.seasonAverage.p90 - player!.seasonAverage.p10;

    expect(week).toBeGreaterThan(average);
  });

  it("widens the season average when the role is less certain", () => {
    const sure = run([back("a")], { ...SETTINGS, roleDrift: 0 })[0]!;
    const unsure = run([back("a")], { ...SETTINGS, roleDrift: 0.9 })[0]!;
    const spread = (p: typeof sure) => p.seasonAverage.p90 - p.seasonAverage.p10;

    expect(spread(unsure)).toBeGreaterThan(spread(sure) * 1.5);
  });

  it("counts a man who misses half the year as playing about half", () => {
    const [player] = run([back("a", { availability: 0.5 })]);

    expect(player!.gamesPlayed).toBeGreaterThan(6);
    expect(player!.gamesPlayed).toBeLessThan(11);
  });

  it("gives a goal-line back more big weeks than a committee back", () => {
    const lead = back("lead", {
      shareIn: { openField: 0.3, thirdAndShort: 0.5, thirdAndLong: 0.1, nearGoal: 0.6 },
    });
    const shared = back("shared", {
      shareIn: { openField: 0.2, thirdAndShort: 0.15, thirdAndLong: 0.1, nearGoal: 0.1 },
    });
    const [a, b] = run([lead, shared]);

    expect(a!.bigWeekChance).toBeGreaterThan(b!.bigWeekChance);
  });

  it("has the season total roughly track the weeks that made it", () => {
    const [player] = run([back("a")]);
    const implied = player!.seasonAverage.median * player!.gamesPlayed;

    expect(player!.total.median).toBeGreaterThan(implied * 0.75);
    expect(player!.total.median).toBeLessThan(implied * 1.25);
  });
});
