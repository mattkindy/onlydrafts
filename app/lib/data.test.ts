import { afterEach, describe, expect, it, vi } from "vitest";

import { loadBoard } from "./data.ts";

describe("the board file's weeks reach the player", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("carries a played week's stat line through untouched", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => ({
        players: [{
          name: "Test Back", key: "test-back", position: "RB", team: "AAA",
          weeks: [
            { w: 1, opp: "v AAA", of: 1, played: { rushYds: 80, rushTd: 1 } },
            { w: 2, opp: "@ BBB", of: 1 },
          ],
        }],
      }),
    }));

    const board = await loadBoard(2026);
    const [week1, week2] = board.players[0]!.weeks!;

    expect(week1!.played).toEqual({ rushYds: 80, rushTd: 1 });
    expect(week2!.played).toBeUndefined();
  });
});
