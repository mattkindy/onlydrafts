import { describe, expect, it } from "vitest";
import {
  INTERACTION_DEFAULTS, fitInteractionNet, predict, type Described,
} from "../model/interactionNet.js";
import { describedFrom, flatNet, raiseNet } from "./matchupTable.js";

describe("describedFrom", () => {
  const opens = new Map([[2024, 1], [2025, 1]]);

  it("describes the August world from the roster", () => {
    expect(describedFrom({ scoreOn: 2025 }, opens)).toBe("cast");
  });

  it("describes week one from the roster, since nothing has been played", () => {
    expect(describedFrom({ scoreOn: 2025, week: 1 }, opens)).toBe("cast");
  });

  it("describes a later week from the plays before it", () => {
    expect(describedFrom({ scoreOn: 2025, week: 3 }, opens)).toBe("plays");
  });

  it("describes a season the file does not have yet from the roster", () => {
    expect(describedFrom({ scoreOn: 2026, week: 3 }, opens)).toBe("cast");
  });
});

describe("the kept network", () => {
  it("predicts the same after a trip through JSON", () => {
    const play = (a: number, b: number): Described[] => [
      { kind: "offence", values: Float64Array.from([a, 1 - a]) },
      { kind: "defence", values: Float64Array.from([b, b / 2]) },
    ];
    const plays = Array.from({ length: 40 }, (_, i) => play((i % 5) / 5, (i % 3) / 3));
    const net = fitInteractionNet(
      plays,
      [{ name: "yards", of: (i) => (i % 7) - 2 }],
      { ...INTERACTION_DEFAULTS, passes: 2 },
    );
    const fitted = {
      net, averageOffence: Float64Array.from([0.4, 0.6]),
      averageDefence: Float64Array.from([0.3, 0.15]),
    };
    const back = raiseNet(JSON.parse(JSON.stringify(flatNet(fitted))));

    for (const on of plays.slice(0, 5)) {
      expect(predict(back.net, on, "yards")).toBeCloseTo(predict(net, on, "yards"), 12);
    }

    expect([...back.averageOffence]).toEqual([0.4, 0.6]);
  });
});
