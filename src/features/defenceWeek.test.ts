import { describe, expect, it } from "vitest";
import {
  DEFENCE_PARTS,
  drawDefenceWeeks,
  drawnQuantile,
  payDefence,
  projectDefenceWeek,
  STANDARD_DEFENCE_PAYS,
  type DefenceWeekRead,
} from "./defenceWeek.js";

const BRACKETS = [
  "pts_allow_0", "pts_allow_1_6", "pts_allow_7_13", "pts_allow_14_20",
  "pts_allow_21_27", "pts_allow_28_34", "pts_allow_35p",
];

/** a defence with nothing of its own yet, against an average side */
const cold: DefenceWeekRead = {
  ownPaid: [],
  lastYearPaid: 8,
  ownParts: {},
  ownGames: 0,
  oppSacksAllowed: 2.3732,
  impliedAgainst: 22,
};

describe("projectDefenceWeek", () => {
  it("gives a rate for every part and a chance for every bracket", () => {
    const line = projectDefenceWeek(cold);

    for (const part of DEFENCE_PARTS) {
      expect(line.parts[part]).toBeGreaterThan(0);
    }

    const chance = BRACKETS.reduce((sum, at) => sum + line.parts[at]!, 0);
    expect(chance).toBeCloseTo(1, 3);
    expect(line.paid).toBeCloseTo(
      payDefence(line.parts, STANDARD_DEFENCE_PAYS), 6,
    );
  });

  /**
   * 11.6269 + 0.1238 x 8 paid weeks + 0.797 x 2.3732 sacks the other
   * side gives up - 0.384 x 22 points the line expects against, and the
   * points allowed 22.61 from -2.6065 + 1.1464 x 22.
   */
  it("pays the fitted total for a hand-worked week", () => {
    const line = projectDefenceWeek(cold);

    expect(line.allowed).toBeCloseTo(22.6143, 3);
    expect(line.paid).toBeCloseTo(6.06, 1);
  });

  it("likes a defence whose opponent the line expects to struggle", () => {
    const easy = projectDefenceWeek({ ...cold, impliedAgainst: 16 });
    const hard = projectDefenceWeek({ ...cold, impliedAgainst: 28 });

    expect(easy.paid).toBeGreaterThan(hard.paid + 3);
    expect(easy.parts["pts_allow_7_13"]!)
      .toBeGreaterThan(hard.parts["pts_allow_7_13"]!);
  });

  it("draws a spread around the line it projects", () => {
    const line = projectDefenceWeek(cold);
    const weeks = drawDefenceWeeks(line.parts, STANDARD_DEFENCE_PAYS, 7);
    const mean = weeks.reduce((sum, n) => sum + n, 0) / weeks.length;

    expect(weeks).toHaveLength(2000);
    expect(mean).toBeCloseTo(line.paid, 0);
    expect(drawnQuantile(weeks, 0.1)).toBeLessThan(line.paid);
    expect(drawnQuantile(weeks, 0.9)).toBeGreaterThan(line.paid);
    expect(drawDefenceWeeks(line.parts, STANDARD_DEFENCE_PAYS, 7))
      .toEqual(weeks);
  });

  it("leans on its own rates once it has games behind them", () => {
    const sacky = projectDefenceWeek({
      ...cold,
      ownGames: 6,
      ownPaid: [8, 8, 8, 8, 8, 8],
      ownParts: { sack: 4, int: 0.7, fum_rec: 0.47, def_td: 0.05 },
    });

    expect(sacky.parts["sack"]!).toBeGreaterThan(
      projectDefenceWeek(cold).parts["sack"]!,
    );
  });
});
