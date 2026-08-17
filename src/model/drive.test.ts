import { describe, expect, it } from "vitest";
import { seededRng } from "../sim/rng.js";
import { simulateDrive, KICK_LENGTH, type DriveRules } from "./drive.js";

/** a plain offence: four yards a carry, no turnovers, never goes for it */
const plainRules = (over: Partial<DriveRules> = {}): DriveRules => ({
  runRate: () => 0.5,
  yardsFor: () => 4,
  turnoverRate: () => 0,
  goesForIt: () => false,
  kickSucceeds: () => 1,
  puntLands: (yardline) => Math.max(20, 100 - Math.max(1, yardline - 40)),
  maxPlays: 20,
  ...over,
});

describe("walking a drive", () => {
  it("moves the chains and keeps going when it gains enough", () => {
    const drive = simulateDrive(75, plainRules(), seededRng(1));

    // four yards a play from the 25 reaches the end zone eventually
    expect(drive.ending).toBe("touchdown");
    expect(drive.plays.length).toBeGreaterThan(10);
  });

  it("gives the ball up on downs when it never gains enough", () => {
    const drive = simulateDrive(
      75, plainRules({ yardsFor: () => 1, goesForIt: () => true }), seededRng(2),
    );

    expect(drive.ending).toBe("downs");
    expect(drive.plays.length).toBe(4);
  });

  it("punts from its own half rather than kicking", () => {
    const drive = simulateDrive(80, plainRules({ yardsFor: () => 0 }), seededRng(3));

    expect(drive.ending).toBe("punt");
    expect(drive.handsOverAt).toBeGreaterThan(20);
  });

  it("kicks when it stalls in range", () => {
    const drive = simulateDrive(25, plainRules({ yardsFor: () => 0 }), seededRng(4));

    expect(drive.ending).toBe("fieldGoal");
  });

  it("hands the ball over where it stalled after a miss", () => {
    const drive = simulateDrive(
      35, plainRules({ yardsFor: () => 0, kickSucceeds: () => 0 }), seededRng(5),
    );

    expect(drive.ending).toBe("missedKick");
    expect(drive.handsOverAt).toBe(65);
  });

  it("stops on a turnover and gives them the ball there", () => {
    const drive = simulateDrive(
      60, plainRules({ turnoverRate: () => 1 }), seededRng(6),
    );

    expect(drive.ending).toBe("turnover");
    expect(drive.handsOverAt).toBe(40);
  });

  it("never gains more yards than there is field left", () => {
    const drive = simulateDrive(
      5, plainRules({ yardsFor: () => 40 }), seededRng(7),
    );

    expect(drive.plays.every((p) => p.yards <= p.state.yardline)).toBe(true);
  });

  it("counts a kick as the yard line plus the snap and the end zone", () => {
    expect(KICK_LENGTH(30)).toBe(47);
  });

  it("gives up rather than running forever", () => {
    const drive = simulateDrive(
      99, plainRules({ yardsFor: () => 0, goesForIt: () => true }), seededRng(8),
    );

    expect(drive.plays.length).toBeLessThanOrEqual(20);
  });
});
