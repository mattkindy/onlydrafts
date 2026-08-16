import { describe, expect, it } from "vitest";
import { seededRng } from "../sim/rng.js";
import { normalDraw } from "../sim/normal.js";
import {
  LEAGUE_PLAYS, simulateSituationalWeek,
  type SituationalRole, type SituationalTeam,
} from "./situationalWeek.js";
import type { Draws } from "./playerWeek.js";
import { fantasyPoints, presets } from "../scoring/fantasyPoints.js";

const drawsFrom = (seed: number): Draws => {
  const rng = seededRng(seed);
  return { uniform: rng, normal: () => normalDraw(rng) };
};

const TEAM: SituationalTeam = { plays: LEAGUE_PLAYS, passShare: 0.54 };

function back(id: string, over: Partial<SituationalRole> = {}): SituationalRole {
  return {
    playerId: id, position: "RB",
    shareIn: { openField: 0.3, thirdAndShort: 0.4, thirdAndLong: 0.1, nearGoal: 0.35 },
    finishIn: { openField: 0.01, thirdAndShort: 0.05, thirdAndLong: 0.02, nearGoal: 0.14 },
    yardsPerTouch: { openField: 4.4, thirdAndShort: 3.2, thirdAndLong: 6.0, nearGoal: 2.4 },
    catchRate: 0.75, availability: 1,
    ...over,
  };
}

const runWeeks = (roster: SituationalRole[], n: number, seed = 8) => {
  const draws = drawsFrom(seed);
  const out: number[][] = roster.map(() => []);

  for (let i = 0; i < n; i++) {
    const lines = simulateSituationalWeek(TEAM, roster, draws);
    lines.forEach((line, j) => out[j]!.push(fantasyPoints(line, presets.standard)));
  }

  return out;
};

describe("drawing a week situation by situation", () => {
  it("scores a goal-line back more than a between-the-twenties one", () => {
    const atTheLine = back("line", {
      shareIn: { openField: 0.15, thirdAndShort: 0.4, thirdAndLong: 0.05, nearGoal: 0.6 },
    });
    const elsewhere = back("field", {
      shareIn: { openField: 0.35, thirdAndShort: 0.1, thirdAndLong: 0.15, nearGoal: 0.05 },
    });
    const [lineWeeks, fieldWeeks] = runWeeks([atTheLine, elsewhere], 2000);
    const scoresPer = (weeks: number[]) => weeks.filter((p) => p > 12).length / weeks.length;

    expect(scoresPer(lineWeeks!)).toBeGreaterThan(scoresPer(fieldWeeks!));
  });

  it("makes touchdowns arrive in lumps rather than smoothly", () => {
    const [weeks] = runWeeks([back("a"), back("b", { shareIn: {
      openField: 0.2, thirdAndShort: 0.2, thirdAndLong: 0.2, nearGoal: 0.2 } })], 3000);
    const sorted = [...weeks!].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const ninth = sorted[Math.floor(sorted.length * 0.9)]!;

    // a big week should be well clear of a normal one
    expect(ninth).toBeGreaterThan(median * 1.6);
  });

  it("hands a missing man's goal-line work to whoever is left", () => {
    const starter = back("starter");
    const withHim = runWeeks([back("other"), starter], 1500)[0]!;
    const withoutHim = runWeeks(
      [back("other"), { ...starter, availability: 0 }], 1500)[0]!;
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

    expect(mean(withoutHim)).toBeGreaterThan(mean(withHim));
  });

  it("keeps a man who never plays off the field", () => {
    const lines = simulateSituationalWeek(
      TEAM, [back("out", { availability: 0 })], drawsFrom(2));

    expect(lines[0]!.played).toBe(false);
    expect(lines[0]!.rushYds).toBe(0);
    expect(lines[0]!.rushTd + lines[0]!.recTd).toBe(0);
  });

  it("gives team-mates competing for the ball a negative correlation", () => {
    const [a, b] = runWeeks([back("a"), back("b")], 3000);
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const ma = mean(a!), mb = mean(b!);
    let num = 0, da = 0, db = 0;

    for (let i = 0; i < a!.length; i++) {
      num += (a![i]! - ma) * (b![i]! - mb);
      da += (a![i]! - ma) ** 2;
      db += (b![i]! - mb) ** 2;
    }

    expect(num / Math.sqrt(da * db)).toBeLessThan(0);
  });
});
