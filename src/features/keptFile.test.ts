import { mkdtemp, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { countedAs } from "./countsCache.js";
import { pruneOlder, writeAside } from "./keptFile.js";

describe("the files kept under data/kept", () => {
  it("are written whole and leave nothing beside them", async () => {
    const folder = await mkdtemp(join(tmpdir(), "kept-"));
    const at = join(folder, "counts16-2025w5-1.json");
    await writeAside(at, "[1,2,3]");

    expect(await readFile(at, "utf8")).toBe("[1,2,3]");
    expect(await readdir(folder)).toEqual(["counts16-2025w5-1.json"]);
  });

  it("clear out the older copies of the same count, keeping the newest one",
    async () => {
      const folder = await mkdtemp(join(tmpdir(), "kept-"));
      const names = [
        "counts12-2025w5-1.json", "counts14-2025w5-2.json",
        "counts16-2025w5-3.json", "counts16-2025w5-4.json",
        // other weeks, other seasons, the August count and the sacks kept
        "counts16-2025w6-3.json", "counts16-2024w5-3.json",
        "counts16-2025-3.json", "counts16w-2025w5-3.json",
        // and one still being written
        "counts16-2025w5-3.123.part.json",
      ];

      for (const [i, name] of names.entries()) {
        await writeFile(join(folder, name), "{}");
        await utimes(join(folder, name), i + 1, i + 1);
      }

      const at = join(folder, "counts16-2025w5-4.json");
      const mine = countedAs("counts16-2025w5-4.json");
      await pruneOlder(at, (name) => countedAs(name) === mine);

      expect((await readdir(folder)).sort()).toEqual([
        "counts16-2024w5-3.json", "counts16-2025-3.json",
        "counts16-2025w5-3.123.part.json", "counts16-2025w5-3.json",
        "counts16-2025w5-4.json", "counts16-2025w6-3.json",
        "counts16w-2025w5-3.json",
      ]);
    });

  it("tell a count's season and weeks from its version and stamp", () => {
    expect(countedAs("counts16-2025w5x2-1790177385592.json"))
      .toBe(countedAs("counts12-2025w5x2-1.json"));
    expect(countedAs("counts16-2025w5-1.json"))
      .not.toBe(countedAs("counts16-2025w50-1.json"));
    expect(countedAs("counts16-2025-1.json"))
      .not.toBe(countedAs("counts16-2025w5-1.json"));
    expect(countedAs("counts16w-2025-1.json"))
      .not.toBe(countedAs("counts16-2025-1.json"));
    expect(countedAs("counts16-2025-1.2.part.json")).toBeUndefined();
  });
});
