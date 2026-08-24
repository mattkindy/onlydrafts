import { describe, expect, it } from "vitest";
import { attributeDrives } from "./attribution.js";
import type { Drive } from "./drive.js";
import type { Draws } from "./playerWeek.js";
import type { SituationalRole } from "./situationalWeek.js";

function steady(): Draws {
  let n = 0;
  return {
    uniform: () => ((n = (n * 9301 + 49297) % 233280) / 233280),
    normal: () => 0,
  };
}

function player(
  playerId: string, carry: number, target: number,
): SituationalRole {
  const all = (value: number) => ({
    openField: value, thirdAndShort: value, thirdAndLong: value, nearGoal: value,
  });

  return {
    playerId, position: "RB",
    targetShare: all(target), carryShare: all(carry),
    catchRate: all(0.65), yardsPerCatch: all(8), yardsPerCarry: all(4),
    scoresPerCatch: all(0.05), scoresPerCarry: all(0.03),
    yardSwing: 0.5, availability: 1,
    ...{ },
  } as SituationalRole;
}

const drive = (plays: Drive["plays"], ending: Drive["ending"]): Drive =>
  ({ plays, ending, handsOverAt: 75 });

const at = (down: number, toGo: number, yardline: number) =>
  ({ down, toGo, yardline, plays: 0 });

describe("attributeDrives", () => {
  it("gives a drive's yards to the men on it and invents none", () => {
    const roster = [player("back", 1, 0), player("wideout", 0, 1), player("qb", 0, 0)];
    const drives = [
      drive([
        { state: at(1, 10, 70), type: "run", yards: 6 },
        { state: at(2, 4, 64), type: "pass", yards: 12 },
        { state: at(1, 10, 52), type: "run", yards: 3 },
      ], "punt"),
    ];
    const lines = attributeDrives(drives, roster, steady(), { quarterback: "qb" });
    const by = new Map(lines.map((l) => [l.playerId, l]));

    expect(by.get("back")!.rushYds).toBe(9);
    expect(by.get("wideout")!.recYds).toBe(12);
    expect(by.get("wideout")!.receptions).toBe(1);
    // the quarterback is credited with the throw
    expect(by.get("qb")!.passYds).toBe(12);

    // the same twelve yards are the receiver's and the passer's, so
    // the yards from scrimmage are the nine and the twelve, once each
    const scrimmage = lines.reduce((sum, l) => sum + l.rushYds + l.recYds, 0);
    expect(scrimmage).toBe(9 + 12);
  });

  it("scores only the play that reached the end zone", () => {
    const roster = [player("back", 1, 0), player("qb", 0, 0)];
    const drives = [
      drive([
        { state: at(1, 10, 8), type: "run", yards: 5 },
        { state: at(2, 5, 3), type: "run", yards: 3 },
      ], "touchdown"),
    ];
    const by = new Map(
      attributeDrives(drives, roster, steady(), { quarterback: "qb" })
        .map((l) => [l.playerId, l]),
    );

    expect(by.get("back")!.rushTd).toBe(1);
    expect(by.get("back")!.rushYds).toBe(8);
  });

  it("credits nobody for a sack and no catch for an incompletion", () => {
    const roster = [player("wideout", 0, 1), player("qb", 0, 0)];
    const drives = [
      drive([
        { state: at(1, 10, 70), type: "pass", yards: -7 },
        { state: at(2, 17, 77), type: "pass", yards: 0 },
      ], "punt"),
    ];
    const by = new Map(
      attributeDrives(drives, roster, steady(), { quarterback: "qb" })
        .map((l) => [l.playerId, l]),
    );

    expect(by.get("wideout")!.receptions).toBe(0);
    expect(by.get("wideout")!.recYds).toBe(0);
    expect(by.get("qb")!.passYds).toBe(0);
  });

  it("splits the work in proportion to the shares", () => {
    const roster = [player("bell", 0.75, 0), player("cow", 0.25, 0), player("qb", 0, 0)];
    const plays = Array.from({ length: 400 }, () => (
      { state: at(1, 10, 60), type: "run" as const, yards: 4 }
    ));
    const by = new Map(
      attributeDrives([drive(plays, "punt")], roster, steady(), { quarterback: "qb" })
        .map((l) => [l.playerId, l]),
    );
    const share = by.get("bell")!.rushYds /
      (by.get("bell")!.rushYds + by.get("cow")!.rushYds);

    expect(share).toBeGreaterThan(0.68);
    expect(share).toBeLessThan(0.82);
  });
});
