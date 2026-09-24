/**
 * The site's index file, which tells the page which season's board to
 * open and which slates it can offer.
 *
 * A build writes one for the season it built. Rebuilding an older season
 * by hand, to fix its slates, must not send the live page back to that
 * season, so the index keeps the newer board and adds the older weeks
 * beside the ones it already lists.
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
  if (!previous || built.boardSeason >= previous.boardSeason) {
    return built;
  }

  const kept = previous.weeks.filter((w) => w.season !== built.boardSeason);

  return { ...previous, weeks: [...kept, ...built.weeks].sort(byWeek) };
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
