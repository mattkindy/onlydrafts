/**
 * For tests that read the nflverse downloads.
 *
 * Those files are gitignored and about a gigabyte, so a fresh clone and
 * the push check in CI do not have them. A suite that needs them is
 * declared with describeWithRawData, which runs it as usual when the
 * downloads are there and otherwise skips it and says why on stderr, so
 * a skipped suite shows up in the run instead of passing unnoticed.
 */

import { existsSync, readdirSync } from "node:fs";
import { describe } from "vitest";
import { RAW_DIR } from "./nflverse.js";

export const hasRawData = existsSync(RAW_DIR) && readdirSync(RAW_DIR).length > 0;

export const RAW_DATA_MISSING =
  "needs data/raw, which is empty or missing (Getting started in README.md says how to fetch it)";

export function describeWithRawData(name: string, suite: () => void): void {
  if (hasRawData) {
    describe(name, suite);
    return;
  }

  console.warn(`skipped "${name}": ${RAW_DATA_MISSING}`);
  describe.skip(`${name} (${RAW_DATA_MISSING})`, suite);
}
