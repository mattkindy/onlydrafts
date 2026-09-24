import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADP_DIR, loadAdp, loadSleeperAdp, mockBoardFile, readAdpSnapshot,
  sleeperBoardFile,
} from "./adp.js";

describe("the committed ADP snapshots", () => {
  it("are read ahead of any downloaded copy", async () => {
    const file = sleeperBoardFile(2026);

    expect(await readAdpSnapshot(file))
      .toBe(await readFile(join(ADP_DIR, file), "utf8"));
  });

  // the weekly build has no raw downloads of its own for these, so a
  // board with Sleeper's room on a few hundred players needs the commit
  it("give the 2026 board Sleeper's room and the mocks' spread", async () => {
    expect((await loadSleeperAdp(2026, "half")).size).toBeGreaterThan(600);
    expect((await loadAdp(2026, "ppr")).size).toBeGreaterThan(150);
    expect((await loadAdp(2026, "standard")).size).toBeGreaterThan(100);
  });

  it("name a board by its format and season", () => {
    expect(mockBoardFile("ppr", 2026)).toBe("adp_ppr_2026.json");
    expect(sleeperBoardFile(2026)).toBe("adp_sleeper_2026.json");
  });
});
