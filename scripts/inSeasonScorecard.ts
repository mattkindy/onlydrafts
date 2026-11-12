/**
 * How the lines the site shipped this season have done against what
 * players went on to score, now that weeks of the season are in.
 *
 * Every other bench scores a model refitted on past seasons. This one
 * scores the slates that went out: each week's file as it stood when its
 * games kicked off, read straight from the repository's history, against
 * the box scores the board carries. So it is the only bench that sees
 * what a reader saw, injury news and Sleeper's number included.
 *
 * A slate counts only if it was written before its week was played, and
 * a row only if the slate was written before that row's own game kicked
 * off: a file written on Sunday morning still has the Thursday game in
 * it. Rows are fantasy relevant players, a blended line of five or more,
 * who dressed for the game. One who did not is counted apart, since no
 * line can be scored against a game he never played.
 *
 * Four lines are scored side by side: ours, Sleeper's, Sleeper's with the
 * quarterback bias the blend takes off, and the blend that shipped. For
 * each, the pair accuracy the blend weight was fitted on (every two
 * players at a position in a week, how often the higher line outscored
 * the lower), the mean absolute error and the bias by position. The
 * shipped bands are scored for how often a week landed inside them:
 * the floor to the ceiling is the 80% range and q1 to q3 the 50%, so a
 * well drawn band holds those shares, with the tail outside split evenly.
 * Then the blend weight is swept on these weeks alone.
 *
 * Run: npx tsx scripts/inSeasonScorecard.ts [--season 2026] [--from 4]
 * Needs data/raw/games.csv for kickoff times, which fetchData downloads.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { addPairs, emptyTally, pairRate, type PairEntry } from "../src/backtest/pairs.js";
import { blendPoints, debiasedSleeper, SHIPPED_BLEND_WEIGHT } from "../src/features/sleeperBlend.js";
import { fantasyPoints, type ScoringRules, type StatLine } from "../src/scoring/fantasyPoints.js";

interface SlateRow {
  key: string;
  name: string;
  position: string;
  team: string;
  ours: number;
  sleeper: number;
  average: number;
  floor: number;
  ceiling: number;
  q1?: number;
  q3?: number;
  ruledOut?: boolean;
}

interface BoardPlayer {
  key: string;
  weeks?: { w: number; played?: Partial<StatLine> | null }[];
}

interface Scored {
  week: number;
  position: string;
  ours: number;
  sleeper: number;
  debiased: number;
  shipped: number;
  floor: number;
  ceiling: number;
  q1: number | null;
  q3: number | null;
  actual: number;
}

const arg = (name: string, fallback: number) => {
  const at = process.argv.indexOf(`--${name}`);

  return at >= 0 ? Number(process.argv[at + 1]) : fallback;
};

const SEASON = arg("season", 2026);
const FROM = arg("from", 4);
const ROOT = join(import.meta.dirname, "..");
const DATA = join(ROOT, "docs", "data");
/** a line under this is a player nobody is choosing between */
const RELEVANT = 5;
const POSITIONS = ["QB", "RB", "WR", "TE"];

/** when a file was last committed, which is when that version of it went out */
function committedAt(file: string): number | null {
  try {
    const said = execFileSync("git", ["log", "-1", "--format=%cI", "--", file], { cwd: ROOT })
      .toString().trim();

    return said ? Date.parse(said) : null;
  } catch {
    return null;
  }
}

/** a New York wall clock time as a moment, whichever side of daylight saving it falls */
function newYork(day: string, time: string): number {
  const naive = Date.parse(`${day}T${time}:00Z`);
  const shown = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(naive));
  const part = (type: string) => Number(shown.find((p) => p.type === type)!.value);
  const asIfUtc = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour") % 24, part("minute"));

  return naive + (naive - asIfUtc);
}

/** every team's kickoff in each week of the season */
function kickoffs(): Map<string, number> {
  const file = join(ROOT, "data", "raw", "games.csv");

  if (!existsSync(file)) {
    throw new Error("data/raw/games.csv is missing; run scripts/fetchData.ts first");
  }

  const [head, ...lines] = readFileSync(file, "utf8").trim().split("\n");
  const cols = head!.split(",");
  const at = (name: string) => cols.indexOf(name);
  const out = new Map<string, number>();

  for (const line of lines) {
    const cells = line.split(",");

    if (Number(cells[at("season")]) !== SEASON || cells[at("game_type")] !== "REG") {
      continue;
    }

    const when = newYork(cells[at("gameday")]!, cells[at("gametime")]!);
    const week = Number(cells[at("week")]);

    out.set(`${week}:${cells[at("home_team")]}`, when);
    out.set(`${week}:${cells[at("away_team")]}`, when);
  }

  return out;
}

const board = JSON.parse(readFileSync(join(DATA, `board-${SEASON}.json`), "utf8")) as {
  scoredBy: ScoringRules; players: BoardPlayer[];
};
const playedBy = new Map(board.players.map((p) => [p.key, p]));
const kicks = kickoffs();
const scored: Scored[] = [];
const notes: string[] = [];
let missed = 0;

for (let week = FROM; ; week++) {
  const file = join(DATA, `slate-${SEASON}-${week}.json`);

  if (!existsSync(file)) {
    break;
  }

  const written = committedAt(file);
  const rows = (JSON.parse(readFileSync(file, "utf8")) as { players: SlateRow[] }).players;
  let kept = 0;
  let late = 0;

  for (const row of rows) {
    if (!POSITIONS.includes(row.position) || row.average < RELEVANT || row.ruledOut) {
      continue;
    }

    const kick = kicks.get(`${week}:${row.team}`);

    // the slate went out after this game had started, so it may know the answer
    if (written === null || kick === undefined || written >= kick) {
      late++;
      continue;
    }

    const played = playedBy.get(row.key)?.weeks?.find((w) => w.w === week)?.played;

    if (played === undefined) {
      // his week is not in yet, which ends the weeks that can be scored
      continue;
    }

    if (played === null) {
      missed++;
      continue;
    }

    const line = { passYds: 0, passTd: 0, interceptions: 0, rushYds: 0, rushTd: 0, receptions: 0,
      recYds: 0, recTd: 0, fumblesLost: 0, twoPointConversions: 0, ...played } as StatLine;

    scored.push({
      week,
      position: row.position,
      ours: row.ours,
      sleeper: row.sleeper,
      debiased: debiasedSleeper(row.position, row.sleeper),
      shipped: row.average,
      floor: row.floor,
      ceiling: row.ceiling,
      q1: row.q1 ?? null,
      q3: row.q3 ?? null,
      actual: fantasyPoints(line, board.scoredBy),
    });
    kept++;
  }

  if (kept === 0 && late === 0) {
    break;
  }

  notes.push(`week ${week}: ${kept} scored, ${late} left out as already kicked off when the slate went out`);
}

const weeks = [...new Set(scored.map((s) => s.week))];
const pct = (n: number) => (n * 100).toFixed(1) + "%";
const fixed = (n: number, places = 2) => (Number.isFinite(n) ? n.toFixed(places) : "–");

/** pair accuracy within each position in each week, pooled */
function pairs(line: (s: Scored) => number, gap = "all"): number {
  const tally = emptyTally();

  for (const week of weeks) {
    for (const position of POSITIONS) {
      const group: PairEntry[] = scored
        .filter((s) => s.week === week && s.position === position)
        .map((s) => ({ predicted: line(s), actual: s.actual }));

      addPairs(tally, group);
    }
  }

  return pairRate(tally, gap);
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

console.log(`\n${SEASON}, weeks ${weeks[0]}–${weeks[weeks.length - 1]}: ${scored.length} player weeks scored, ` +
  `${missed} relevant players who did not dress left out`);
notes.forEach((n) => console.log("  " + n));

const LINES: [string, (s: Scored) => number][] = [
  ["ours", (s) => s.ours],
  ["sleeper", (s) => s.sleeper],
  ["sleeper, qb bias off", (s) => s.debiased],
  ["shipped blend", (s) => s.shipped],
];

console.log("\nline                   pairs all   0-2    2-5    5+    mae    bias by position (line minus scored)");

for (const [name, line] of LINES) {
  const bias = POSITIONS.map((position) => {
    const at = scored.filter((s) => s.position === position);

    return `${position} ${fixed(mean(at.map((s) => line(s) - s.actual)), 1)}`;
  }).join("  ");

  console.log(`${name.padEnd(22)} ${pct(pairs(line)).padStart(6)}  ${pct(pairs(line, "0-2")).padStart(6)} ` +
    `${pct(pairs(line, "2-5")).padStart(6)} ${pct(pairs(line, "5+")).padStart(6)}  ` +
    `${fixed(mean(scored.map((s) => Math.abs(line(s) - s.actual)))).padStart(5)}   ${bias}`);
}

console.log("\nbands, share of weeks landing        80% range: below  inside  above     50% range: inside");

for (const position of [...POSITIONS, "all"]) {
  const at = scored.filter((s) => position === "all" || s.position === position);
  const quartered = at.filter((s) => s.q1 !== null && s.q3 !== null);

  console.log(`  ${position.padEnd(4)} (${String(at.length).padStart(4)})` +
    `                            ${pct(mean(at.map((s) => Number(s.actual < s.floor)))).padStart(6)}` +
    ` ${pct(mean(at.map((s) => Number(s.actual >= s.floor && s.actual <= s.ceiling)))).padStart(7)}` +
    ` ${pct(mean(at.map((s) => Number(s.actual > s.ceiling)))).padStart(6)}` +
    `              ${pct(mean(quartered.map((s) => Number(s.actual >= s.q1! && s.actual <= s.q3!)))).padStart(6)}`);
}

console.log(`\nblend weight on these weeks (0 all ours, 1 all Sleeper with the qb bias off; ships ${SHIPPED_BLEND_WEIGHT}):`);

const sweep = Array.from({ length: 11 }, (_, i) => i / 10).map((weight) => ({
  weight,
  rate: pairs((s) => blendPoints(s.ours, s.debiased, weight)),
}));
const best = sweep.reduce((a, b) => (b.rate > a.rate ? b : a));

console.log("  " + sweep.map((s) => `${s.weight.toFixed(1)} ${pct(s.rate)}`).join("  "));
console.log(`  best ${best.weight.toFixed(1)} at ${pct(best.rate)}`);

for (const week of weeks) {
  const at = (line: (s: Scored) => number) => {
    const tally = emptyTally();

    for (const position of POSITIONS) {
      addPairs(tally, scored.filter((s) => s.week === week && s.position === position)
        .map((s) => ({ predicted: line(s), actual: s.actual })));
    }

    return pairRate(tally, "all");
  };

  console.log(`  week ${week}: ours ${pct(at((s) => s.ours))}, sleeper ${pct(at((s) => s.debiased))}, ` +
    `shipped ${pct(at((s) => s.shipped))}`);
}
