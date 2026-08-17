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

  // head coaches and offensive coordinators in one file, defensive
  // coordinators in another because that one is thin and its rows have
  // to be checked before anything leans on them
  const defensive = await readFile(
    join(CURATED_DIR, "coordinators.csv"), "utf8",
  ).catch(() => "");
  const rows = [
    ...parseCsv(await readFile(join(CURATED_DIR, "coaches.csv"), "utf8")),
    ...(defensive ? parseCsv(defensive) : []),
  ];
  cached = new Map(
    rows.map((row) => [
      `${row["team"]}|${row["season"]}|${row["role"]}`,
      row["name"] ?? "",
    ]),
  );

  return cached;
}
