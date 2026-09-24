/**
 * The site's index file, which tells the page which season's board to
 * open and which slates it can offer.
 *
 * A build writes only the coming week's slate, so the index keeps the
 * weeks it already lists and adds that one, and a build for a newer
 * season starts the list again. Rebuilding an older season by hand must
 * not send the live page back to that season, so the newer board stays.
 */

import { readFile } from "node:fs/promises";

export interface WeekRef {
  season: number;
  week: number;
}

export interface SiteIndex {
  weeks: WeekRef[];
  boardSeason: number;
  adpFormat: string;
}

const byWeek = (a: WeekRef, b: WeekRef) =>
  a.season - b.season || a.week - b.week;

export function mergeSiteIndex(
  previous: SiteIndex | undefined, built: SiteIndex,
): SiteIndex {
  if (!previous || built.boardSeason > previous.boardSeason) {
    return built;
  }

  const listed = new Map<string, WeekRef>();

  for (const week of [...previous.weeks, ...built.weeks]) {
    listed.set(`${week.season}-${week.week}`, week);
  }

  const weeks = [...listed.values()].sort(byWeek);

  if (built.boardSeason === previous.boardSeason) {
    return { ...built, weeks };
  }

  return { ...previous, weeks };
}

/**
 * The index on disk, or nothing on a first build. An older index listed
 * bare week numbers, which belong to its board season.
 */
export function parseSiteIndex(text: string): SiteIndex | undefined {
  const raw = JSON.parse(text) as {
    weeks?: unknown[]; boardSeason?: number; adpFormat?: string;
  };

  if (typeof raw.boardSeason !== "number") {
    return undefined;
  }

  const season = raw.boardSeason;
  const weeks = (raw.weeks ?? []).flatMap((entry): WeekRef[] => {
    if (typeof entry === "number") {
      return [{ season, week: entry }];
    }

    if (entry && typeof entry === "object" && "week" in entry) {
      const ref = entry as Partial<WeekRef>;

      return [{ season: ref.season ?? season, week: Number(ref.week) }];
    }

    return [];
  });

  return { weeks, boardSeason: season, adpFormat: raw.adpFormat ?? "ppr" };
}

export async function readSiteIndex(
  path: string,
): Promise<SiteIndex | undefined> {
  const text = await readFile(path, "utf8").catch(() => "");

  return text ? parseSiteIndex(text) : undefined;
}
