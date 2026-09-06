import { describe, expect, it } from "vitest";
import {
  joinProjectionsToGsis,
  projectionKey,
  type SleeperProjectionRow,
} from "./sleeperProjections.js";

const crosswalk = new Map([
  ["1479", "00-0030279"],
  ["11576", "00-0039794"],
]);

function row(
  playerId: string,
  stats: SleeperProjectionRow["stats"],
  position = "RB",
): SleeperProjectionRow {
  return { player_id: playerId, player: { position }, stats };
}

describe("joinProjectionsToGsis", () => {
  it("keys a projection by the gsis id the crosswalk gives", () => {
    const joined = joinProjectionsToGsis(
      2024,
      3,
      [row("11576", { pts_ppr: 5.4, rec_tgt: 1.4, rush_att: 5.8 })],
      crosswalk,
    );

    expect(joined).toEqual([
      {
        season: 2024,
        week: 3,
        gsisId: "00-0039794",
        position: "RB",
        points: 5.4,
        targets: 1.4,
        carries: 5.8,
      },
    ]);
  });

  it("drops a player the crosswalk does not know", () => {
    const joined = joinProjectionsToGsis(
      2024,
      3,
      [row("99999", { pts_ppr: 12 })],
      crosswalk,
    );

    expect(joined).toEqual([]);
  });

  it("drops a row with no ppr projection rather than calling it zero", () => {
    const joined = joinProjectionsToGsis(
      2024,
      3,
      [row("1479", { rec_tgt: 4 })],
      crosswalk,
    );

    expect(joined).toEqual([]);
  });

  it("treats a missing target or carry count as none", () => {
    const joined = joinProjectionsToGsis(
      2024,
      3,
      [row("1479", { pts_ppr: 9 }, "WR")],
      crosswalk,
    );

    expect(joined[0]!.targets).toBe(0);
    expect(joined[0]!.carries).toBe(0);
  });

  it("builds the same key from a season, week and player", () => {
    expect(projectionKey(2025, 7, "00-0030279")).toBe("2025|7|00-0030279");
  });
});
