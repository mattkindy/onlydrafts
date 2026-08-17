import { describe, expect, it } from "vitest";
import { seededRng } from "../sim/rng.js";
import { normalDraw } from "../sim/normal.js";
import type { FittedDrives } from "../features/driveRules.js";
import { linesFrom, simulatePlayerDrive } from "./playerDrive.js";
import type { Draws } from "./playerWeek.js";
import type { SituationalRole } from "./situationalWeek.js";

// what runs really gain, roughly: mostly nothing much, sometimes a lot
const POOL = [-3, -1, 0, 0, 1, 2, 2, 3, 3, 4, 4, 5, 6, 7, 9, 12, 18, 30];

const rules = (over: Partial<FittedDrives> = {}): FittedDrives => ({
  runRate: () => 1,
  yardsFor: (_type, _down, _toGo, uniform) =>
    POOL[Math.floor(uniform() * POOL.length)]!,
  turnoverRate: () => 0,
  goesForIt: () => false,
  kickSucceeds: () => 1,
  puntLands: (yardline) => Math.max(20, 100 - Math.max(1, yardline - 40)),
  penaltyFirstDown: 0,
  penaltyYards: () => 10,
  maxPlays: 20,
  plays: 0,
  caughtYards: (_down, _toGo, uniform) =>
    POOL.filter((n) => n > 0)[
      Math.floor(uniform() * POOL.filter((n) => n > 0).length)
    ]!,
  means: { carry: 4.3, caught: 11.6 },
  sackRate: 0,
  sackYards: () => -7,
  ...over,
});

function drawsFrom(seed: number): Draws {
  const rng = seededRng(seed);
  return { uniform: rng, normal: () => normalDraw(rng) };
}

function back(playerId: string, yardsPerCarry: number): SituationalRole {
  const all = (value: number) => ({
    openField: value, thirdAndShort: value, thirdAndLong: value, nearGoal: value,
  });

  return {
    playerId, position: "RB",
    targetShare: all(0), carryShare: all(1),
    catchRate: all(0.64), yardsPerCatch: all(10.4),
    yardsPerCarry: all(yardsPerCarry),
    scoresPerCatch: all(0), scoresPerCarry: all(0),
    yardSwing: 0, availability: 1,
  } as SituationalRole;
}

/** yards a back gains over many drives, with everything else held still */
function gainedBy(yardsPerCarry: number): number {
  const roster = [back("him", yardsPerCarry)];
  const drives = Array.from({ length: 400 }, (_, i) =>
    simulatePlayerDrive(75, roster, [true], rules(), drawsFrom(i + 1)));
  return linesFrom(drives, roster, [true], "").reduce((a, l) => a + l.rushYds, 0);
}

describe("a drive made of what its players did", () => {
  it("gives a better back more yards, which the old walk could not", () => {
    const ordinary = gainedBy(4.3);
    const good = gainedBy(5.6);
    const poor = gainedBy(3.2);

    expect(good).toBeGreaterThan(ordinary);
    expect(ordinary).toBeGreaterThan(poor);
    // and by enough to matter, not by a rounding
    expect(good / ordinary).toBeGreaterThan(1.05);
  });

  it("credits the man who had it, not whoever comes to hand", () => {
    const roster = [back("bell", 5), back("cow", 5)];
    roster[1]!.carryShare = {
      openField: 0, thirdAndShort: 0, thirdAndLong: 0, nearGoal: 0,
    };
    const drives = Array.from({ length: 50 }, (_, i) =>
      simulatePlayerDrive(75, roster, [true, true], rules(), drawsFrom(i + 1)));
    const lines = linesFrom(drives, roster, [true, true], "");

    expect(lines.find((l) => l.playerId === "cow")!.rushYds).toBe(0);
    expect(lines.find((l) => l.playerId === "bell")!.rushYds).toBeGreaterThan(0);
  });

  it("puts the passing on the quarterback and the catch on the receiver", () => {
    const roster = [back("wideout", 4), back("qb", 4)];
    roster[0]!.carryShare = {
      openField: 0, thirdAndShort: 0, thirdAndLong: 0, nearGoal: 0,
    };
    roster[0]!.targetShare = {
      openField: 1, thirdAndShort: 1, thirdAndLong: 1, nearGoal: 1,
    };
    roster[1]!.carryShare = roster[0]!.carryShare;
    const drives = Array.from({ length: 80 }, (_, i) =>
      simulatePlayerDrive(
        75, roster, [true, true], rules({ runRate: () => 0 }), drawsFrom(i + 1),
      ));
    const lines = linesFrom(drives, roster, [true, true], "qb");
    const wideout = lines.find((l) => l.playerId === "wideout")!;
    const qb = lines.find((l) => l.playerId === "qb")!;

    expect(wideout.receptions).toBeGreaterThan(0);
    expect(qb.passYds).toBe(wideout.recYds);
  });
});
