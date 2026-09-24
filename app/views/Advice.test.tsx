import { describe, expect, it } from "vitest";
import { render } from "preact";

import { standingFor } from "../lib/matchups.ts";
import type { Side } from "../lib/providers.ts";
import type { Player } from "../lib/scoring.ts";
import { withByesZeroed } from "../lib/slate.ts";
import { Advice, pct, pctPair } from "./Advice.tsx";

const side = (owner: string, starters: Side["starters"]): Side => ({
  owner, points: 0, starters, bench: [],
});

describe("pct", () => {
  it("rounds to a whole percent in the middle", () => {
    expect(pct(0.843)).toBe("84%");
    expect(pct(0.5)).toBe("50%");
  });

  it("keeps a tenth when a game is nearly settled", () => {
    expect(pct(0.994)).toBe("99.4%");
    expect(pct(0.003)).toBe("0.3%");
  });

  it("rounds the tenth toward the middle, so only a settled game says 100 or 0", () => {
    expect(pct(0.9997)).toBe("99.9%");
    expect(pct(0.0002)).toBe("0.1%");
    expect(pct(1)).toBe("100%");
    expect(pct(0)).toBe("0%");
  });

  it("says the same tenth from either side of the same game", () => {
    expect(pct(0.999)).toBe("99.9%");
    expect(pct(1 - 0.999)).toBe("0.1%");
    expect(pct(0.9985)).toBe("99.8%");
    expect(pct(1 - 0.9985)).toBe("0.2%");
  });
});

describe("pctPair", () => {
  it("makes both whole sides add up to 100", () => {
    expect(pctPair(0.635)).toEqual(["64%", "36%"]);
    expect(pctPair(0.365)).toEqual(["36%", "64%"]);
    expect(pctPair(0.5)).toEqual(["50%", "50%"]);
  });

  it("keeps the tenths when a game is nearly settled", () => {
    expect(pctPair(0.9985)).toEqual(["99.8%", "0.2%"]);
    expect(pctPair(0.003)).toEqual(["0.3%", "99.7%"]);
  });
});

describe("Advice", () => {
  it("says no lineup is set rather than pricing an empty one", () => {
    const container = document.createElement("div");
    const mine = side("me", []);
    const opp = side("them", [{ key: "qb", points: 10, slot: "QB" }]);

    render(
      <Advice
        side={mine}
        against={opp}
        slots={null}
        rows={new Map()}
        states={new Map()}
        lines={new Map()}
      />,
      container,
    );

    expect(container.textContent).toContain("no lineup set");
    expect(container.textContent).not.toContain("wins");
  });

  it("says which starter is on bye, and projects him nothing", () => {
    const container = document.createElement("div");
    const lines = new Map([["jamarrchase", {
      key: "jamarrchase", name: "Ja'Marr Chase", position: "WR", team: "CIN",
      game: { ev: 22.5, q1: 15, mid: 21, q3: 29, low: 8, high: 40 },
    } as Player]]);
    const rows = withByesZeroed(
      new Map(),
      [{ key: "jamarrchase", name: "Ja'Marr Chase", position: "WR", team: "CIN" }],
      (team) => team !== "CIN",
    );
    const mine = side("me", [{ key: "jamarrchase", points: 0, slot: "WR" }]);
    const opp = side("them", [{ key: "qb", points: 0, slot: "QB" }]);
    const states = new Map([["KC", { where: "pre" as const, left: 1 }]]);

    const standing = standingFor({ sides: [mine, opp] }, { rows, states, lines });

    expect(standing.projected[0]).toBe(0);

    render(
      <Advice
        side={mine}
        against={opp}
        slots={null}
        rows={rows}
        states={states}
        lines={lines}
      />,
      container,
    );

    expect(container.textContent).toContain("Ja'Marr Chase is on bye this week.");
  });
});
