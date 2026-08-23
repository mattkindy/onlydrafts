/** The pick log, built from what Sleeper answers with. */

import { render } from "preact";
import { beforeEach, describe, expect, it } from "vitest";
import { DraftView, type DraftNow, type Pick } from "./views/Draft.tsx";
import type { Player } from "./lib/scoring.ts";

const man = (name: string, i: number): Player => ({
  name, key: name.toLowerCase().replace(/[^a-z]/g, ""), position: "RB",
  team: "PIT", ppg: 15 - i * 0.1, vor: 100 - i, games: 15,
  adp: i + 1, adpLow: i + 10, adpHigh: Math.max(1, i - 5),
});

const made: Pick[] = [
  { overall: 1, round: 1, slot: 1, name: "Bijan Robinson", position: "RB", who: "tarpey", mine: false, keeper: false },
  { overall: 2, round: 1, slot: 2, name: "Ja'Marr Chase", position: "WR", who: "mattkindy", mine: true, keeper: true },
];

let where: HTMLElement;

beforeEach(() => {
  where = document.createElement("div");
  document.body.appendChild(where);
});

describe("picks so far", () => {
  const men = Array.from({ length: 40 }, (_, i) => man("Player " + i, i));
  const state: DraftNow = {
    taken: new Set(["bijanrobinson"]), mine: new Set(), teams: {},
    rosteredBy: {}, grid: null, made,
  };

  it("lists them newest first, with who took each", () => {
    render(
      <DraftView men={men} state={state} teams={12} snake posFilter="ALL"
        query="" byAdp={false} onMore={() => {}} />,
      where,
    );
    const shown = where.textContent!;
    expect(shown).toContain("picks so far (2)");
    expect(shown).toContain("Ja'Marr Chase");
    expect(shown).toContain("tarpey");
    expect(shown).toContain("keeper");

    // newest first, so the second pick comes before the first
    expect(shown.indexOf("Ja'Marr Chase")).toBeLessThan(shown.indexOf("Bijan Robinson"));
  });

  it("says nothing when the draft has not started", () => {
    render(
      <DraftView men={men} state={{ ...state, made: [] }} teams={12} snake
        posFilter="ALL" query="" byAdp={false} onMore={() => {}} />,
      where,
    );
    expect(where.textContent).not.toContain("picks so far");
  });
});
