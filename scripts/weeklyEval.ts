/**
 * Does the weekly view know anything about a week?
 *
 * Every weekly change this week went out on reasoning. Nothing marks
 * them, because the board bench scores a season's ordering and says
 * nothing about a week. This is the missing instrument.
 *
 * The question is narrow on purpose. Not whether a man's average is
 * right, which the season bench already asks, but whether saying this
 * week is 6% above his average and that one 4% below beats saying
 * every week is his average.
 *
 * Run: npx tsx scripts/weeklyEval.ts [season]
 */

import { loadPlayerStats, loadGames } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { parseCsv } from "../src/data/csv.js";
import { readingsFrom, kickoffsIn } from "../src/data/gameWeather.js";
import { settingLift, type Setting } from "../src/features/weekSetting.js";
import { liftFor } from "../src/features/gameScript.js";
import { loadGameScript } from "../src/data/gameScriptTable.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SEASON = Number(process.argv[2] ?? 2024);
const RULES = presets.ppr;
const POSITIONS = ["QB", "RB", "WR", "TE"];
/** below this a week is mostly whether he scored, not how he played */
const ENOUGH_GAMES = 10;

const rows = parseCsv(await readFile(
  join(import.meta.dirname, "..", "data", "raw", "games.csv"), "utf8"));

const where = new Map<string, Setting>();
const facing = new Map<string, string>();

for (const k of kickoffsIn(rows, SEASON)) {
  for (const [team, against, rest] of [
    [k.homeTeam, k.awayTeam, k.homeRest],
    [k.awayTeam, k.homeTeam, k.awayRest],
  ] as [string, string, number][]) {
    where.set(`${team}|${k.week}`, {
      indoors: k.indoors, night: k.hour >= 18, restDays: rest,
    });
    facing.set(`${team}|${k.week}`, against);
  }
}

const script = await loadGameScript(SEASON);

interface Week {
  points: number;
  week: number;
  team: string;
}

interface Man {
  position: string;
  weeks: Week[];
  carries: number;
  targets: number;
}

const men = new Map<string, Man>();

for (const s of await loadPlayerStats(SEASON)) {
  if (!POSITIONS.includes(s.position) || s.week > 18) {
    continue;
  }

  const his = men.get(s.playerId) ?? {
    position: s.position, weeks: [], carries: 0, targets: 0,
  };
  his.weeks.push({
    points: fantasyPoints(s.statLine, RULES), week: s.week, team: s.teamId,
  });
  his.carries += s.carries;
  his.targets += s.targets;
  men.set(s.playerId, his);
}

/** what each way of guessing says a week is worth, against his own average */
const ways: [string, (man: Man, week: Week) => number][] = [
  ["saying every week is his average", () => 1],
  ["the roof, the night and the short week", (man, week) =>
    settingLift(man.position, where.get(`${week.team}|${week.week}`) ??
      { indoors: false, night: false, restDays: 7 })],
  ["what the fixture does to his side's running", (man, week) => {
    const against = facing.get(`${week.team}|${week.week}`);
    const runShare = man.carries + man.targets > 0
      ? man.carries / (man.carries + man.targets)
      : 0;

    return against ? liftFor(script, against, runShare) : 1;
  }],
  ["both together", (man, week) => {
    const against = facing.get(`${week.team}|${week.week}`);
    const runShare = man.carries + man.targets > 0
      ? man.carries / (man.carries + man.targets)
      : 0;
    const setting = settingLift(man.position,
      where.get(`${week.team}|${week.week}`) ??
      { indoors: false, night: false, restDays: 7 });

    return setting * (against ? liftFor(script, against, runShare) : 1);
  }],
];

interface Pair { said: number; was: number }

console.log(`Weekly deviations in ${SEASON}, against a man's own average.`);
console.log("Nothing here is asked to get his average right, only to say");
console.log("which of his weeks are the good ones.\n");
console.log("                                              n    error    with it");

for (const [name, of] of ways) {
  const pairs: Pair[] = [];

  for (const man of men.values()) {
    if (man.weeks.length < ENOUGH_GAMES) {
      continue;
    }

    const average = man.weeks.reduce((s, w) => s + w.points, 0) / man.weeks.length;

    if (average < 4) {
      continue;
    }

    // his own lifts taken back to a mean of one, the way the board
    // does it, so a way of guessing cannot win by moving his average
    const lifts = man.weeks.map((w) => of(man, w));
    const middle = lifts.reduce((s, l) => s + l, 0) / lifts.length;

    man.weeks.forEach((w, i) => {
      pairs.push({
        said: middle > 0 ? lifts[i]! / middle : 1,
        was: w.points / average,
      });
    });
  }

  const off = Math.sqrt(
    pairs.reduce((s, p) => s + (p.said - p.was) ** 2, 0) / pairs.length,
  );
  const ms = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const sa = pairs.map((p) => p.said);
  const wa = pairs.map((p) => p.was);
  const ma = ms(sa);
  const mw = ms(wa);
  let top = 0;
  let left = 0;
  let right = 0;

  for (const p of pairs) {
    top += (p.said - ma) * (p.was - mw);
    left += (p.said - ma) ** 2;
    right += (p.was - mw) ** 2;
  }

  const together = left > 0 && right > 0 ? top / Math.sqrt(left * right) : 0;

  console.log(
    `  ${name.padEnd(42)} ${String(pairs.length).padStart(5)}  ` +
    `${off.toFixed(4)}   ${together >= 0 ? " " : ""}${together.toFixed(4)}`,
  );
}

console.log("\nA week is mostly the afternoon, so the error barely moves and");
console.log("the number to read is whether it goes with what happened at all.");
