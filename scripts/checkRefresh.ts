/**
 * Is the site the build just wrote worth publishing?
 *
 * A refresh that fetched nothing, or a release nflverse has only half
 * published, still writes a board and a slate that look normal from the
 * outside. What they are is thinner: fewer players, nobody hurt, a week
 * that went backwards. This compares what is on disk against the copy
 * committed to git and fails the run rather than publishing it.
 *
 * Run: npx tsx scripts/checkRefresh.ts [--season 2026]
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** how much of a board may go missing before it is wrong */
const LEAST_KEPT = 0.9;

/** below this many players a slate is broken however the count moved */
const LEAST_ON_A_SLATE = 200;

interface Index {
  weeks: { season: number; week: number }[];
  boardSeason: number;
}

interface Slate {
  season: number;
  week: number;
  players: { position: string; questionable: boolean }[];
}

interface Board {
  players: unknown[];
}

const complaints: string[] = [];

const grumble = (what: string) => complaints.push(what);

/** the same file as it was committed, or nothing if it is new */
async function asCommitted(path: string): Promise<string | null> {
  const { stdout } = await run(
    "git", ["show", `HEAD:${path}`], { maxBuffer: 64 * 1024 * 1024 },
  ).catch(() => ({ stdout: "" }));

  return stdout === "" ? null : stdout;
}

const read = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(join(import.meta.dirname, "..", path), "utf8")) as T;

function seasonAsked(): number | null {
  const at = process.argv.indexOf("--season");

  if (at === -1) {
    return null;
  }

  return Number(process.argv[at + 1]);
}

/** the newest week the site says it has for a season */
const latestWeek = (index: Index, season: number) =>
  index.weeks
    .filter((week) => week.season === season)
    .reduce((best, week) => Math.max(best, week.week), 0);

async function checkBoard(season: number): Promise<void> {
  const path = `docs/data/board-${season}.json`;
  const now = await read<Board>(path);
  const before = await asCommitted(path);

  if (now.players.length === 0) {
    grumble(`the ${season} board has nobody on it`);

    return;
  }

  if (before === null) {
    return;
  }

  const was = (JSON.parse(before) as Board).players.length;

  if (now.players.length < was * LEAST_KEPT) {
    grumble(
      `the ${season} board fell from ${was} players to ${now.players.length}`);
  }
}

async function checkSlate(season: number, week: number): Promise<void> {
  const now = await read<Slate>(`docs/data/slate-${season}-${week}.json`);
  const skill = now.players.filter((p) => p.position !== "DEF");

  if (now.players.length < LEAST_ON_A_SLATE) {
    grumble(
      `the ${season} week ${week} slate has ${now.players.length} players, ` +
      "where a full one runs to several hundred");
  }

  // the defences come off a different path from everybody else, so a
  // slate can lose every skill player and still look populated
  if (skill.length === 0) {
    grumble(`the ${season} week ${week} slate has no skill players at all`);
  }

  // A fetch that failed leaves a slate where nobody is ever hurt, but
  // clubs file the week's report on the Wednesday, so only a week the
  // report already covers can be judged this way.
  const reported = await injuryRowsFor(season, week);

  if (reported > 0 && skill.length > 0 && !skill.some((p) => p.questionable)) {
    grumble(
      `nobody on the ${season} week ${week} slate is questionable, though ` +
      `the injury file lists ${reported} players that week`);
  }
}

/**
 * How many players the clubs gave a status that week. A row with the
 * status left blank is a club filing its practice report before it has
 * ruled anybody in or out, and a week of those says nothing about
 * whether the slate should have somebody questionable on it.
 */
async function injuryRowsFor(season: number, week: number): Promise<number> {
  const text = await readFile(
    join(import.meta.dirname, "..", "data", "raw", `injuries_${season}.csv`),
    "utf8",
  ).catch(() => "");

  if (!text) {
    return 0;
  }

  const lines = text.split("\n");
  const head = (lines[0] ?? "").split(",");
  const at = head.indexOf("week");
  const saying = head.indexOf("report_status");

  return lines
    .slice(1)
    .filter((line) => {
      const cells = line.split(",");

      return Number(cells[at]) === week && (cells[saying] ?? "").trim() !== "";
    })
    .length;
}

async function checkWeekWentForward(
  index: Index, season: number,
): Promise<void> {
  const before = await asCommitted("docs/data/index.json");

  if (before === null) {
    return;
  }

  const was = latestWeek(JSON.parse(before) as Index, season);
  const now = latestWeek(index, season);

  if (now < was) {
    grumble(`the site went back from ${season} week ${was} to week ${now}`);
  }
}

async function main(): Promise<void> {
  const index = await read<Index>("docs/data/index.json");
  const season = seasonAsked() ?? index.boardSeason;
  const week = latestWeek(index, season);

  if (week === 0) {
    grumble(`the site has no week at all for ${season}`);
  } else {
    await checkSlate(season, week);
  }

  await checkBoard(season);
  await checkWeekWentForward(index, season);

  if (complaints.length === 0) {
    console.log(`${season} week ${week} looks worth committing`);

    return;
  }

  console.error(`the ${season} refresh is not worth committing:`);

  for (const complaint of complaints) {
    console.error(`  ${complaint}`);
  }

  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
