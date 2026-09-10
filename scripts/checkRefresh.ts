/**
 * Checks a refreshed site is worth committing. A cold machine that
 * fetched nothing still builds a site that looks normal: the board and
 * the slate come out, and nobody in them is ever hurt. So this compares
 * what was written against what is committed, and looks for the inputs
 * the build reads quietly, failing when one is missing or thin.
 *
 * Run: npx tsx scripts/checkRefresh.ts [--season 2026]
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  currentSeason, hasPlayerStats, loadGames, RAW_DIR,
} from "../src/data/nflverse.js";

const ROOT = join(import.meta.dirname, "..");
const DOCS = join(ROOT, "docs");
/** how much of a committed file has to survive a refresh */
const KEPT = 0.9;
/** the touches table only grows, so a season losing rows is a bad sign */
const TOUCHES_KEPT = 0.99;
const FEWEST_ON_BOARD = 300;
const FEWEST_ON_SLATE = 150;

/** the file as HEAD has it, or empty when HEAD has never seen it */
function committed(path: string): string {
  try {
    return execFileSync("git", ["show", `HEAD:${path}`], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 1 << 30,
    });
  } catch {
    return "";
  }
}

function rowsBySeason(text: string): Map<number, number> {
  const counts = new Map<number, number>();

  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("season,")) {
      continue;
    }

    const season = Number(line.slice(0, line.indexOf(",")));
    counts.set(season, (counts.get(season) ?? 0) + 1);
  }

  return counts;
}

function menIn(text: string): number {
  try {
    return JSON.parse(text).players.length;
  } catch {
    return 0;
  }
}

/** a file with a header and nothing under it is as good as absent */
function thinFile(name: string): string[] {
  const path = join(RAW_DIR, name);

  if (!existsSync(path)) {
    return [`${name} is not in data/raw, so the build could not see it`];
  }

  const rows = readFileSync(path, "utf8").split("\n")
    .filter((line) => line !== "").length - 1;

  if (rows < 1) {
    return [`${name} has a header and no rows under it`];
  }

  console.log(`  ${name}: ${rows} rows`);
  return [];
}

function touchesKept(): string[] {
  const now = rowsBySeason(
    readFileSync(join(ROOT, "data", "curated", "touches.csv"), "utf8"),
  );
  const before = rowsBySeason(committed("data/curated/touches.csv"));
  const wrong: string[] = [];

  for (const [season, was] of before) {
    const has = now.get(season) ?? 0;

    if (has < was * TOUCHES_KEPT) {
      wrong.push(
        `touches.csv has ${has} rows for ${season} where the committed ` +
          `file has ${was}`,
      );
    }
  }

  const seasons = [...now.keys()].sort((a, b) => a - b);
  console.log(`  touches.csv: ${seasons.join(", ")}`);
  return wrong;
}

function jsonKept(name: string, fewest: number): string[] {
  const path = join(DOCS, "data", name);

  if (!existsSync(path)) {
    return [`${name} was not written`];
  }

  const text = readFileSync(path, "utf8");
  const men = menIn(text);
  const was = menIn(committed(`docs/data/${name}`));
  const wrong: string[] = [];

  if (men < fewest) {
    wrong.push(`${name} has ${men} men, fewer than the ${fewest} expected`);
  }

  if (was > 0 && men < was * KEPT) {
    wrong.push(`${name} has ${men} men where the committed file has ${was}`);
  }

  console.log(`  ${name}: ${men} men${was > 0 ? ` (was ${was})` : ""}`);
  return wrong;
}

/** a week already built from played games must not come back preseason */
function slateStillPlayed(name: string): string[] {
  const before = committed(`docs/data/${name}`);
  const now = readFileSync(join(DOCS, "data", name), "utf8");

  try {
    if (before !== "" && !JSON.parse(before).preseason
      && JSON.parse(now).preseason) {
      return [`${name} came back from the preseason path over a played week`];
    }
  } catch {
    return [`${name} is not readable as a slate`];
  }

  return [];
}

async function main(): Promise<void> {
  const flag = process.argv.indexOf("--season");
  const season = flag === -1
    ? currentSeason()
    : Number(process.argv[flag + 1]);
  const games = await loadGames();
  const played = hasPlayerStats(season) || games.some(
    (game) => game.season === season && game.homeScore !== undefined,
  );

  console.log(
    `checking the ${season} site, a season ` +
      (played ? "under way" : "nobody has played yet"),
  );

  const wrong: string[] = [];

  // Nobody is listed as hurt before a season starts, so the injury and
  // chart files are only worth insisting on once it is under way.
  if (played) {
    wrong.push(...thinFile(`injuries_${season}.csv`));
    wrong.push(...thinFile(`depth_charts_${season}.csv`));
  }

  wrong.push(...touchesKept());
  wrong.push(...jsonKept(`board-${season}.json`, FEWEST_ON_BOARD));

  const index = JSON.parse(
    readFileSync(join(DOCS, "data", "index.json"), "utf8"),
  ) as { weeks: { season: number; week: number }[] };
  const weeks = index.weeks.filter((week) => week.season === season);

  if (weeks.length === 0) {
    wrong.push(`the site index has no week for ${season}`);
  }

  for (const { week } of weeks) {
    const name = `slate-${season}-${week}.json`;
    wrong.push(...jsonKept(name, FEWEST_ON_SLATE));
    wrong.push(...slateStillPlayed(name));
  }

  if (wrong.length > 0) {
    console.error(`\nthe ${season} refresh is not worth committing:`);

    for (const line of wrong) {
      console.error(`  ${line}`);
    }

    process.exit(1);
  }

  console.log(`\nthe ${season} refresh holds up`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
