/**
 * The page has to work in the preseason, when there are no weekly
 * slates and data/index.json says `weeks: []`. A single unguarded
 * `meta.weeks.at(-1).season` used to throw there, and because it threw
 * before the first setView, every toolbar control stayed on screen at
 * once with no title and no tabs.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

let page: string;
let script: string;

beforeAll(async () => {
  page = await readFile(join(import.meta.dirname, "index.html"), "utf8");
  script = page.split("<script>")[1]!.split("</script>")[0]!;
});

describe("the page shell", () => {
  it("parses", () => {
    expect(() => new Function(script)).not.toThrow();
  });

  it("never reads a week off an empty list", () => {
    expect(script).not.toMatch(/meta\.weeks\.at\(-1\)\.[a-z]/);
  });

  it("starts with every optional control hidden", () => {
    for (const id of ["weekwrap", "keepwrap", "searchwrap", "posfilter", "manualwrap"]) {
      expect(page).toMatch(new RegExp(`id="${id}"[^>]*\\shidden`));
    }
  });

  it("keeps the toolbar table and the markup in step", () => {
    const declared = new Set(
      [...script.matchAll(/fields: \[([^\]]*)\]/g)]
        .flatMap((m) => m[1]!.split(","))
        .map((f) => f.trim().replace(/["']/g, ""))
        .filter(Boolean),
    );

    for (const field of declared) {
      expect(page).toContain(`id="${field}"`);
    }
  });

  it("falls back to a usable view when the index cannot be read", () => {
    expect(script).toMatch(/boot\(\)\.catch\([\s\S]*setView\("leagues"\)/);
  });
});
