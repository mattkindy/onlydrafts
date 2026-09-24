/**
 * The workflows and the npm scripts run files in this folder by path,
 * and nothing else notices when one of those files is deleted or
 * renamed. The refresh then fails on its next scheduled run, days later.
 * This reads the workflows and package.json and checks that every script
 * they mention is there.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");
const SCRIPT_PATH = /scripts\/[\w./-]+\.ts/g;

function scriptsIn(text: string): string[] {
  return [...new Set(text.match(SCRIPT_PATH) ?? [])];
}

const sources: [string, string][] = [
  ["package.json", readFileSync(join(ROOT, "package.json"), "utf8")],
  ...readdirSync(WORKFLOWS)
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file): [string, string] => [
      `.github/workflows/${file}`,
      readFileSync(join(WORKFLOWS, file), "utf8"),
    ]),
];

describe("scripts the workflows and package.json run", () => {
  it("finds workflows and scripts to check", () => {
    expect(sources.length).toBeGreaterThan(1);
    expect(sources.flatMap(([, text]) => scriptsIn(text)).length)
      .toBeGreaterThan(0);
  });

  for (const [source, text] of sources) {
    it(`${source} mentions only scripts that exist`, () => {
      const missing = scriptsIn(text)
        .filter((script) => !existsSync(join(ROOT, script)));

      expect(missing).toEqual([]);
    });
  }
});
