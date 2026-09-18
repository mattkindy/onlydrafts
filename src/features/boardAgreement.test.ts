import { describe, expect, it } from "vitest";
import { disagreements, type StatedPlayer } from "./boardAgreement.js";
import { presets } from "../scoring/fantasyPoints.js";

/** the line the 2026 board shipped for Devaughn Vele */
const vele: StatedPlayer = {
  name: "Devaughn Vele",
  position: "WR",
  ppg: 8.2,
  projected: {
    passYds: 0.04, rushYds: 0.39, receptions: 3.15, recYds: 36.55,
    recTd: 0.19, carries: 0.05, targets: 4.69,
  },
  game: { ev: 8.2 },
};

describe("disagreements", () => {
  it("catches the receiver whose card said twice what his line scored", () => {
    // 8.2 a game beside 4.1 of line is the fault this check exists for
    const found = disagreements([{
      ...vele,
      projected: {
        receptions: 1.59, recYds: 19.11, recTd: 0.1, rushYds: 0.05,
        targets: 2.81, carries: 0.02,
      },
    }], presets.ppr);

    expect(found).toHaveLength(1);
    expect(found[0]!.about).toBe("the stat line");
    expect(found[0]!.worth).toBeCloseTo(4.11, 2);
  });

  it("catches the fifth of a point the two fits were apart on him", () => {
    const found = disagreements([vele], presets.ppr);

    expect(found.map((f) => f.about)).toEqual(["the stat line"]);
  });

  it("passes a player whose points are his own line scored", () => {
    const agreed = { ...vele, ppg: 7.99, game: { ev: 8 } };

    expect(disagreements([agreed], presets.ppr)).toEqual([]);
  });

  it("scores by the rules it is given, not by whatever the build used", () => {
    // no point a catch takes him to 4.8, so PPR's 8.2 is wrong there
    const standard = disagreements([vele], presets.standard);

    expect(standard).toHaveLength(1);
    expect(standard[0]!.worth).toBeCloseTo(4.84, 2);
  });

  it("catches a spread hung off a different game from the line", () => {
    const found = disagreements(
      [{ ...vele, ppg: 7.99, game: { ev: 12.4 } }], presets.ppr);

    expect(found.map((f) => f.about)).toEqual(["the spread"]);
  });

  it("has nothing to say about a kicker or a defence", () => {
    const kicker: StatedPlayer = {
      name: "Cameron Dicker", position: "K", ppg: 8.6, projected: null,
    };

    expect(disagreements([kicker], presets.ppr)).toEqual([]);
  });
});
