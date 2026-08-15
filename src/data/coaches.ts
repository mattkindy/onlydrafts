import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "./csv.js";

const CURATED_DIR = join(import.meta.dirname, "..", "..", "data", "curated");

let cached: Map<string, string> | undefined;

/** `${team}|${season}|${role}` -> name, from the curated week-1 staff list */
export async function loadCoaches(): Promise<Map<string, string>> {
  if (cached) {
    return cached;
  }

  const rows = parseCsv(await readFile(join(CURATED_DIR, "coaches.csv"), "utf8"));
  cached = new Map(
    rows.map((row) => [
      `${row["team"]}|${row["season"]}|${row["role"]}`,
      row["name"] ?? "",
    ]),
  );

  return cached;
}
