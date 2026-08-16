import { describe, expect, it } from "vitest";
import { replacementLevels, type StarterSlots } from "./replacement.js";

const SLOTS: StarterSlots = {
  teams: 2,
  QB: 1,
  RB: 1,
  WR: 1,
  TE: 0,
  flex: 1,
  superFlex: 0,
};

function pool(position: string, scores: number[]) {
  return scores.map((ppg) => ({ position, ppg }));
}

describe("replacementLevels", () => {
  it("sets replacement at the best player nobody starts", () => {
    const { levels } = replacementLevels(
      [
        ...pool("QB", [30, 28, 26]),
        ...pool("RB", [20, 18, 16, 14]),
        ...pool("WR", [19, 17, 15, 13]),
        ...pool("TE", [10, 8]),
      ],
      { ...SLOTS, flex: 0 },
    );

    expect(levels["QB"]).toBe(26);
    expect(levels["RB"]).toBe(16);
    expect(levels["WR"]).toBe(15);
  });

  it("gives flex slots to the deeper position rather than a fixed split", () => {
    const deepAtBack = replacementLevels(
      [
        ...pool("QB", [30, 28, 26]),
        ...pool("RB", [20, 19, 18, 17, 16]),
        ...pool("WR", [15, 9, 8, 7]),
        ...pool("TE", [6]),
      ],
      SLOTS,
    );

    // both flex slots go to backs, so two more backs start than receivers
    expect(deepAtBack.starters["RB"]).toBe(4);
    expect(deepAtBack.starters["WR"]).toBe(2);
    expect(deepAtBack.levels["RB"]).toBe(16);
  });

  it("moves replacement down when the pool loses its top players", () => {
    const everyone = [
      ...pool("QB", [30, 28, 26]),
      ...pool("RB", [20, 18, 16, 14, 12]),
      ...pool("WR", [19, 17, 15, 13, 11]),
      ...pool("TE", [10]),
    ];
    const full = replacementLevels(everyone, { ...SLOTS, flex: 0 });
    const thinned = replacementLevels(
      everyone.filter((p) => !(p.position === "RB" && p.ppg >= 18)),
      { ...SLOTS, flex: 0 },
    );

    expect(full.levels["RB"]).toBe(16);
    expect(thinned.levels["RB"]).toBe(12);
    expect(thinned.levels["WR"]).toBe(full.levels["WR"]);
  });

  it("lets a superflex slot take a quarterback", () => {
    const { starters } = replacementLevels(
      [
        ...pool("QB", [40, 38, 36, 34]),
        ...pool("RB", [20, 18, 16]),
        ...pool("WR", [19, 17, 15]),
        ...pool("TE", [10]),
      ],
      { ...SLOTS, flex: 0, superFlex: 1 },
    );

    expect(starters["QB"]).toBe(4);
  });
});
