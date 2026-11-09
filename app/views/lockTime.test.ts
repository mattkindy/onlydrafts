import { describe, expect, it } from "vitest";
import type { GameState } from "../lib/matchups.ts";
import { kickoffSays, nextLockOf } from "./Matchup.tsx";

const at = (where: GameState["where"], kickoff?: number): GameState => ({
  where, left: where === "post" ? 0 : 1, ...(kickoff ? { kickoff } : {}),
});

describe("when your next starter kicks off", () => {
  it("takes the earliest kickoff still to come", () => {
    expect(nextLockOf([at("pre", 300), at("pre", 200), at("in", 100), null]))
      .toBe(200);
  });

  it("has nothing to say once every starter has kicked off", () => {
    expect(nextLockOf([at("in", 100), at("post", 50)])).toBeNull();
    expect(nextLockOf([at("pre"), null])).toBeNull();
  });

  it("says a close lock in minutes and hours", () => {
    const now = 1_000_000_000;

    expect(kickoffSays(now + 40 * 60000, now)).toBe("kickoff in 40 min");
    expect(kickoffSays(now + 140 * 60000, now)).toBe("kickoff in 2h 20m");
    expect(kickoffSays(now + 180 * 60000, now)).toBe("kickoff in 3h");
    expect(kickoffSays(now - 60000, now)).toBe("kicking off now");
  });

  it("says a far one as a day and a time", () => {
    const now = Date.UTC(2026, 10, 5, 12);

    expect(kickoffSays(now + 3 * 24 * 3600000, now)).toMatch(/^kickoff \w{3}/);
  });
});
