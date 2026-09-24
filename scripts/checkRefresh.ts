/**
 * Is the site the build wrote a moment ago worth publishing?
 *
 * A refresh that fetched nothing, or a release nflverse has only half
 * published, still writes a board and a slate that look normal from the
 * outside. What they are is thinner: fewer players, nobody hurt, nobody
 * with a Sleeper number, no forecast, a week that went backwards. This
 * compares what is on disk against floors and against the copy committed
 * to git, and fails the run rather than publishing it. When the Action
 * sets GITHUB_STEP_SUMMARY, a line per source goes there too.
 *
 * Run: npx tsx scripts/checkRefresh.ts [--season 2026] [--week 3]
 */

import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { loadQuestionableCount } from "../src/data/injuries.js";
import {
  currentSeason, loadGames, type GameRow,
} from "../src/data/nflverse.js";
import { loadWeatherWeekly } from "../src/data/weatherWeekly.js";
import {
  disagreements, type StatedPlayer,
} from "../src/features/boardAgreement.js";
import { presets, type ScoringRules } from "../src/scoring/fantasyPoints.js";
import {
  calendarWeek, forecastCount, sleeperPriced, sleeperShare,
} from "./refreshChecks.js";

const run = promisify(execFile);

/** how much of a board or a slate may go missing before it is wrong */
const LEAST_KEPT = 0.9;

/** below this many players a slate is broken however the count moved */
const LEAST_ON_A_SLATE = 200;

/**
 * How many players a week's injury report has to doubt before a slate
 * with nobody questionable reads as a failed fetch. One or two of them
 * are often backups the slate never lists.
 */
const ENOUGH_DOUBTED = 5;

/**
 * The share of a slate's skill players Sleeper has a number for, a zero
 * for a quiet player included. The committed slates run from 0.77 (2025
 * week 10) and 0.83 (the 2026 preseason week 1) to 0.99 in season.
 */
const LEAST_SLEEPER_SHARE = 0.75;

/**
 * Players on the board priced from Sleeper's drafts. A build with the
 * Sleeper board prices about 700, and one without it prices none.
 */
const LEAST_SLEEPER_PRICED = 500;

/**
 * Open-Meteo forecasts sixteen days out, and a game late on the last of
 * them can fall past its final hour, so the check looks two days short.
 */
const FORECAST_DAYS = 14;

/** one ground may fail after its retries without failing the run */
const LEAST_FORECAST_SHARE = 0.9;

/** the positions a slate lists, so a hurt guard is not counted here */
const ON_A_SLATE = ["QB", "RB", "FB", "WR", "TE", "K"];

interface Index {
  weeks: { season: number; week: number }[];
  boardSeason: number;
}

interface SlateFile {
  season: number;
  week: number;
  players: {
    position: string; questionable: boolean; sleeper?: number | null;
  }[];
}

interface Board {
  players: (StatedPlayer & {
    adpBy?: Record<string, { from?: string } | undefined> | null;
  })[];
  /** the rules the build scored the board under, absent on an older file */
  scoredBy?: ScoringRules;
}

/**
 * How many players may disagree with their own stat line. None: two
 * numbers for the same player is the fault this exists to catch, and a
 * board that ships one of them has a broken fit behind it.
 */
const MOST_AT_ODDS = 0;

interface Status {
  source: string;
  ok: boolean;
  detail: string;
}

const statuses: Status[] = [];

const pass = (source: string, detail: string) =>
  statuses.push({ source, ok: true, detail });

const fail = (source: string, detail: string) =>
  statuses.push({ source, ok: false, detail });

/** the same file as it was committed, or nothing if it is new */
async function asCommitted(path: string): Promise<string | null> {
  const { stdout } = await run(
    "git", ["show", `HEAD:${path}`], { maxBuffer: 64 * 1024 * 1024 },
  ).catch(() => ({ stdout: "" }));

  return stdout === "" ? null : stdout;
}

const read = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(join(import.meta.dirname, "..", path), "utf8")) as T;

function numberArg(flag: string): number | null {
  const at = process.argv.indexOf(flag);

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

async function checkBoard(season: number, board: Board): Promise<void> {
  const before = await asCommitted(`docs/data/board-${season}.json`);

  if (board.players.length === 0) {
    fail("board", `the ${season} board has nobody on it`);

    return;
  }

  if (before === null) {
    pass("board", `${board.players.length} players, a new file`);

    return;
  }

  const was = (JSON.parse(before) as Board).players.length;

  if (board.players.length < was * LEAST_KEPT) {
    fail("board",
      `the ${season} board fell from ${was} players to ${board.players.length}`);

    return;
  }

  pass("board", `${board.players.length} players, ${was} in the last commit`);
}

/**
 * Whether each player's points a game are what his own stat line
 * scores. The card prints both, the page prices him off one and the
 * lineup advice off the other, so two different numbers for the same
 * player is a bug wherever it comes from.
 */
function checkBoardAgrees(season: number, board: Board): void {
  // an older board did not say what it was scored under, and PPR is
  // what a refresh without a league uses
  const argued = disagreements(board.players, board.scoredBy ?? presets.ppr);

  if (argued.length <= MOST_AT_ODDS) {
    pass("board lines", "every player matches his own stat line");

    return;
  }

  const worst = [...argued]
    .sort((a, b) => Math.abs(b.said - b.worth) - Math.abs(a.said - a.worth))
    .slice(0, 5)
    .map((said) =>
      `${said.who} (${said.about}: ${said.worth.toFixed(1)} against ` +
        `${said.said.toFixed(1)})`)
    .join(", ");

  fail("board lines",
    `${argued.length} players on the ${season} board disagree with their ` +
      `own stat line: ${worst}`);
}

function checkAdp(season: number, board: Board): void {
  const priced = sleeperPriced(board.players);

  if (priced < LEAST_SLEEPER_PRICED) {
    fail("ADP",
      `${priced} players on the ${season} board are priced from Sleeper's ` +
        `drafts, where a board with the Sleeper snapshot has about 700`);

    return;
  }

  pass("ADP", `${priced} players priced from Sleeper's drafts`);
}

async function checkSlate(slate: SlateFile): Promise<void> {
  const { season, week } = slate;
  const skill = slate.players.filter((p) => p.position !== "DEF");
  const before = await asCommitted(`docs/data/slate-${season}-${week}.json`);
  const was = before === null
    ? null
    : (JSON.parse(before) as SlateFile).players.length;

  if (slate.players.length < LEAST_ON_A_SLATE) {
    fail("slate",
      `the ${season} week ${week} slate has ${slate.players.length} ` +
        "players, where a full one runs to several hundred");

    return;
  }

  // the defences come off a different path from everybody else, so a
  // slate can lose every skill player and still look populated
  if (skill.length === 0) {
    fail("slate", `the ${season} week ${week} slate has no skill players at all`);

    return;
  }

  if (was !== null && slate.players.length < was * LEAST_KEPT) {
    fail("slate",
      `the ${season} week ${week} slate fell from ${was} players to ` +
        `${slate.players.length}`);

    return;
  }

  pass("slate",
    `${slate.players.length} players` +
      (was === null ? ", a new week" : `, ${was} in the last commit`));
}

/**
 * A fetch that failed leaves a slate where nobody is ever hurt, but
 * clubs file the week's report on the Wednesday, so only a week the
 * report already covers can be judged this way.
 */
async function checkInjuries(slate: SlateFile): Promise<void> {
  const { season, week } = slate;
  const skill = slate.players.filter((p) => p.position !== "DEF");
  const reported = await loadQuestionableCount(season, week, ON_A_SLATE);
  const listed = skill.filter((p) => p.questionable).length;

  if (reported >= ENOUGH_DOUBTED && skill.length > 0 && listed === 0) {
    fail("injury report",
      `nobody on the ${season} week ${week} slate is questionable, though ` +
        `the injury file lists ${reported} players that week`);

    return;
  }

  pass("injury report",
    `${listed} questionable on the slate, ${reported} in the report`);
}

function checkSleeper(slate: SlateFile): void {
  const share = sleeperShare(slate.players);
  const said = `${(share * 100).toFixed(0)}% of the skill players`;

  if (share < LEAST_SLEEPER_SHARE) {
    fail("Sleeper projections",
      `Sleeper has a number for ${said} on the ${slate.season} week ` +
        `${slate.week} slate, under the floor of ` +
        `${(LEAST_SLEEPER_SHARE * 100).toFixed(0)}%`);

    return;
  }

  pass("Sleeper projections", `a number for ${said}`);
}

async function checkForecast(
  games: GameRow[], season: number, today: Date,
): Promise<void> {
  const count = forecastCount(
    games, await loadWeatherWeekly(), season, today, FORECAST_DAYS,
  );

  if (count.due === 0) {
    pass("weather", `no outdoor games in the next ${FORECAST_DAYS} days`);

    return;
  }

  const said = `${count.forecast} of the ${count.due} outdoor games in ` +
    `the next ${FORECAST_DAYS} days have a forecast`;

  if (count.forecast < count.due * LEAST_FORECAST_SHARE) {
    fail("weather",
      `${said}; the rest fell back to the ground's climate, which is what ` +
        "happens when Open-Meteo fails");

    return;
  }

  pass("weather", said);
}

/**
 * Whether the week built is the one coming. A dispatch that asked for a
 * particular week passes it with --week; otherwise the calendar decides.
 */
function checkWeekIsNext(
  games: GameRow[], index: Index, season: number, today: Date,
): void {
  const built = latestWeek(index, season);
  const wanted = numberArg("--week") ?? calendarWeek(games, season, today);

  if (built !== wanted) {
    fail("week",
      `the site's newest ${season} week is ${built}, where the coming week ` +
        `is ${wanted}; the schedule file may have stopped updating`);

    return;
  }

  pass("week", `${season} week ${built}`);
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
    fail("week", `the site went back from ${season} week ${was} to week ${now}`);
  }
}

async function writeSummary(season: number, week: number): Promise<void> {
  const path = process.env["GITHUB_STEP_SUMMARY"];

  if (!path) {
    return;
  }

  const rows = statuses.map((s) =>
    `| ${s.source} | ${s.ok ? "ok" : "FAILED"} | ${s.detail.replace(/\|/g, "/")} |`);
  const text = [
    `### Refresh check for ${season} week ${week}`,
    "",
    "| source | status | detail |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");

  await appendFile(path, text);
}

async function main(): Promise<void> {
  const index = await read<Index>("docs/data/index.json");
  const season = numberArg("--season") ?? index.boardSeason;
  const week = latestWeek(index, season);
  const today = new Date();
  const games = await loadGames();
  const board = await read<Board>(`docs/data/board-${season}.json`);

  if (week === 0) {
    fail("slate", `the site has no week at all for ${season}`);
  } else {
    const slate = await read<SlateFile>(`docs/data/slate-${season}-${week}.json`);

    await checkSlate(slate);
    await checkInjuries(slate);
    checkSleeper(slate);
  }

  await checkBoard(season, board);
  checkBoardAgrees(season, board);

  // an older season rebuilt by hand has no draft room or forecast to
  // check, and its slates are for weeks long played
  if (season === currentSeason(today)) {
    checkAdp(season, board);
    await checkForecast(games, season, today);
    checkWeekIsNext(games, index, season, today);
  }

  await checkWeekWentForward(index, season);
  await writeSummary(season, week);

  const failed = statuses.filter((s) => !s.ok);

  for (const s of statuses) {
    console.log(`${s.ok ? "ok    " : "FAILED"} ${s.source}: ${s.detail}`);
  }

  if (failed.length === 0) {
    console.log(`${season} week ${week} looks worth committing`);

    return;
  }

  console.error(`the ${season} refresh is not worth committing:`);

  for (const s of failed) {
    console.error(`  ${s.detail}`);
  }

  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
