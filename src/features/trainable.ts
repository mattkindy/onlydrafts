/**
 * Whether a training set is worth fitting, and what to say when it is
 * not. When the weekly stats file has no column for a part, every row
 * reads nought for it, so the season model fits happily and the parts
 * model is handed nothing at all. The message says which seasons
 * produced rows and which parts came out empty, so a reader knows which
 * input to go and look at.
 */

import { PART_NAMES, type StatParts } from "./seasonSummary.js";
import { partBefore } from "./partsModel.js";
import type { SeasonExample } from "./seasonModel.js";

/** the least a part needs before a ridge on it means anything */
const FEWEST_ROWS = 20;

export function usableByPart(
  examples: SeasonExample[],
): Map<keyof StatParts, number> {
  const counts = new Map<keyof StatParts, number>();

  for (const part of PART_NAMES) {
    counts.set(
      part,
      examples.filter((e) =>
        e.actualParts !== undefined && partBefore(e, part) > 0.2).length,
    );
  }

  return counts;
}

export function trainingComplaint(
  examples: SeasonExample[],
  bySeason: Map<number, number>,
): string | undefined {
  const found = [...bySeason.entries()]
    .map(([season, rows]) => `${season}: ${rows}`)
    .join(", ");
  const empty = [...usableByPart(examples).entries()]
    .filter(([, rows]) => rows < FEWEST_ROWS)
    .map(([part, rows]) => `${part} (${rows})`);

  if (examples.length === 0) {
    return `no training rows from any season. Rows by season: ${found}. ` +
      "Every season needs its weekly stats in data/raw, under either " +
      "player_stats_<season>.csv or stats_player_week_<season>.csv.";
  }

  if (empty.length > 0) {
    return `${examples.length} training rows, but too few carry ` +
      `${empty.join(", ")}. Rows by season: ${found}. A part that is ` +
      "nought on every row means the weekly stats file has no column " +
      "for it, which happens when nflverse renames one.";
  }

  return undefined;
}

export function assertTrainable(
  examples: SeasonExample[],
  bySeason: Map<number, number>,
): void {
  const complaint = trainingComplaint(examples, bySeason);

  if (complaint !== undefined) {
    throw new Error(complaint);
  }
}
