import { describe, expect, it } from "vitest";

import { movesFor } from "./Matchup.tsx";

const says = (key: string) => `${key} line`;
const nameOf = (key: string) => key.toUpperCase();

describe("one move a slot", () => {
  it("names a bench swap on the row of the starter it replaces", () => {
    const moves = movesFor({
      swaps: [{ starts: "shakir", benches: "burden", gains: 0.15 }],
      worries: [], says, nameOf,
    });

    expect(moves.get("burden")).toEqual({
      kind: "start", key: "shakir", name: "SHAKIR", says: "shakir line", gains: 0.15,
    });
  });

  it("leaves out a swap worth less than a point", () => {
    const moves = movesFor({
      swaps: [{ starts: "a", benches: "b", gains: 0.004 }], worries: [], says, nameOf,
    });

    expect(moves.size).toBe(0);
  });

  it("offers a free agent only where the bench does not already cover the slot", () => {
    const fill = { key: "young", name: "Bryce Young", says: "16.0 @ NO", gains: 0.24 };
    const moves = movesFor({
      swaps: [{ starts: "shakir", benches: "burden", gains: 0.15 }],
      worries: [
        { key: "burden", slot: "WR", how: "bad", fill: { ...fill, key: "other" } },
        { key: "hurts", slot: "QB", how: "bad", fill },
      ],
      says, nameOf,
    });

    expect(moves.get("burden")!.kind).toBe("start");
    expect(moves.get("hurts")).toEqual({ kind: "add", ...fill });
  });

  it("sends you looking when nobody on the bench or the wire helps", () => {
    const moves = movesFor({
      swaps: [], worries: [{ key: "empty-DEF0", slot: "DEF", how: "bad" }], says, nameOf,
    });

    expect(moves.get("empty-DEF0")).toEqual({ kind: "find", position: "DEF" });
  });

  it("says nothing about a questionable starter, whose badge already does", () => {
    const moves = movesFor({
      swaps: [], worries: [{ key: "q", slot: "RB", how: "warn" }], says, nameOf,
    });

    expect(moves.size).toBe(0);
  });
});
