/**
 * The touches file is grouped by season, oldest first, and a weekly
 * refresh only re-derives the season being played. The other seasons'
 * rows come back out of the file exactly as they went in, so nothing
 * downstream can tell a merged file from a full rebuild.
 *
 * A season that derives nothing keeps the rows already in the file.
 * That is what makes a refresh safe on a machine with no play files at
 * all, and in the weeks before nflverse publishes the season being
 * played: the alternative is a file with the season silently missing.
 */

/** the rows for one season, in the order the play file gave them */
export type SeasonRows = Map<number, string[]>;

export interface Merge {
  /** every season the file should contain, in any order */
  seasons: number[];
  /** the seasons this run tried to derive */
  asked: number[];
  onDisk: SeasonRows;
  derived: SeasonRows;
}

export interface Merged {
  rows: string[];
  /** asked seasons whose play file gave nothing, so the old rows stand */
  kept: number[];
}

export function mergedTouches(merge: Merge): Merged {
  const order = [...new Set(merge.seasons)].sort((a, b) => a - b);
  const rows: string[] = [];
  const kept: number[] = [];

  for (const season of order) {
    const derived = merge.derived.get(season) ?? [];
    const onDisk = merge.onDisk.get(season) ?? [];

    if (derived.length > 0) {
      rows.push(...derived);
      continue;
    }

    if (merge.asked.includes(season) && onDisk.length > 0) {
      kept.push(season);
    }

    rows.push(...onDisk);
  }

  return { rows, kept };
}
