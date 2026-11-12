import { describe, expect, it } from "vitest";
import { endingsFrom } from "./driveEndings.js";

const play = (playType: string, down: number, yards: number, turnover = "0") => ({
  offense: "NE", playType, down: String(down), togo: "10",
  yardline: "60", yards: String(yards), turnover,
});

describe("what ends a drive besides the factors", () => {
  const rows = [
    ...Array.from({ length: 30 }, () => play("run", 1, 4)),
    ...Array.from({ length: 2 }, () => play("run", 2, 0, "1")),
    ...Array.from({ length: 60 }, () => play("pass", 2, 7)),
    ...Array.from({ length: 4 }, () => play("pass", 3, 0, "1")),
    ...Array.from({ length: 4 }, () => play("penalty", 2, 15)),
    ...Array.from({ length: 5 }, () => play("offenceFlag", 1, 10)),
    // a false start before a punt is not a snap the walk takes
    play("offenceFlag", 4, 5),
    play("defenceFlag", 3, 5),
  ];
  const endings = endingsFrom(rows);

  it("gives the ball away at each call's own rate", () => {
    expect(endings.turnoverRate("run")).toBeCloseTo(2 / 32);
    expect(endings.turnoverRate("pass")).toBeCloseTo(4 / 64);
  });

  it("counts a defensive first down against every snap and flag", () => {
    expect(endings.penaltyFirstDown).toBeCloseTo(4 / 100);
    expect(endings.penaltyYards(() => 0.5)).toBe(15);
  });

  it("leaves fourth down out of the flags that replay a down", () => {
    expect(endings.offenceFlag).toBeCloseTo(5 / 106);
    expect(endings.defenceFlag).toBeCloseTo(1 / 106);
    expect(endings.offenceFlagYards(() => 0.99)).toBe(10);
  });

  it("swings away from deep and pins from near midfield", () => {
    // from his own twenty, 80 out, the ball dies 36 to 50 yards on
    expect(endings.puntLands(80, () => 0)).toBe(56);
    expect(endings.puntLands(80, () => 1)).toBe(70);
    // from their forty, a pin, and a kick into the end zone comes out at the twenty
    expect(endings.puntLands(40, () => 0.5)).toBe(90);
    expect(endings.puntLands(5, () => 0)).toBe(80);
  });
});
