import { describe, expect, it } from "vitest";
import { buildGraph, mapPosition, type RosterAppearance } from "./build.js";
import { teamOf } from "./types.js";

function appearance(
  overrides: Partial<RosterAppearance> & { week: number },
): RosterAppearance {
  return {
    playerId: "p1",
    name: "Test Player",
    rawPosition: "WR",
    teamId: "DET",
    season: 2023,
    ...overrides,
  };
}

describe("mapPosition", () => {
  it("collapses line and secondary labels into groups", () => {
    expect(mapPosition("T")).toBe("OL");
    expect(mapPosition("FS")).toBe("S");
    expect(mapPosition("DE")).toBe("EDGE");
    expect(mapPosition("fb")).toBe("RB");
  });

  it("leaves unknown labels unmapped", () => {
    expect(mapPosition("LS")).toBeUndefined();
  });
});

describe("buildGraph", () => {
  it("merges consecutive weeks with one team into one stint", () => {
    const { graph } = buildGraph(
      [appearance({ week: 1 }), appearance({ week: 2 }), appearance({ week: 5 })],
      [],
    );

    expect(graph.playerStints).toEqual([
      {
        playerId: "p1",
        teamId: "DET",
        span: { from: { season: 2023, week: 1 }, to: { season: 2023, week: 5 } },
      },
    ]);
  });

  it("closes a stint when the team changes", () => {
    const { graph } = buildGraph(
      [
        appearance({ week: 1 }),
        appearance({ week: 2 }),
        appearance({ week: 3, teamId: "KC" }),
      ],
      [],
    );

    expect(graph.playerStints).toHaveLength(2);
    expect(teamOf(graph, "p1", { season: 2023, week: 2 })).toBe("DET");
    expect(teamOf(graph, "p1", { season: 2023, week: 3 })).toBe("KC");
  });

  it("keeps one stint across seasons with the same team", () => {
    const { graph } = buildGraph(
      [appearance({ week: 18 }), appearance({ season: 2024, week: 1 })],
      [],
    );

    expect(graph.playerStints).toHaveLength(1);
    expect(teamOf(graph, "p1", { season: 2024, week: 1 })).toBe("DET");
  });

  it("counts appearances with unmapped positions instead of failing", () => {
    const { graph, skippedPositions } = buildGraph(
      [appearance({ week: 1, rawPosition: "LS", playerId: "p2" })],
      [],
    );

    expect(graph.players.size).toBe(0);
    expect(skippedPositions.get("LS")).toBe(1);
  });

  it("registers teams from games even without roster rows", () => {
    const { graph } = buildGraph(
      [],
      [
        {
          id: "2023_01_DET_KC",
          season: 2023,
          week: 1,
          homeTeamId: "KC",
          awayTeamId: "DET",
        },
      ],
    );

    expect([...graph.teams.keys()].sort()).toEqual(["DET", "KC"]);
  });
});
