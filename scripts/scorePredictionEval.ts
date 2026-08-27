/**
 * Is the walk any good at football?
 *
 * It gets a seat on the board and its weekly output has been argued
 * about all week, and nobody ever asked the plain question: does it
 * say what the score will be. Vegas is the benchmark, because a line
 * is the best public guess there is and it is in the games file.
 *
 * Run: npx tsx scripts/scorePredictionEval.ts [season]
 */

import { buildWorld } from "../src/features/playedWorld.js";
import { playGame, type Side } from "../src/model/gameFromDrives.js";
import { kickingVenue } from "../src/features/kickingVenue.js";
import { fitClimate } from "../src/features/climate.js";
import { readingsFrom, kickoffsIn } from "../src/data/gameWeather.js";
import { HOME } from "../src/features/climate.js";
import { parseCsv } from "../src/data/csv.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { seededRng } from "../src/sim/rng.js";
import { rmse } from "../src/backtest/metrics.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SEASON = Number(process.argv[2] ?? 2024);
const RUNS = Number(process.env["RUNS"] ?? 30);

const positions = new Map<string, string>();

for (const s of await loadPlayerStats(SEASON - 1)) {
  positions.set(s.playerId, s.position);
}

console.log(`building the world as it looked before ${SEASON}...`);
const world = await buildWorld(SEASON, 1, false, positions);

const rows = parseCsv(await readFile(
  join(import.meta.dirname, "..", "data", "raw", "games.csv"), "utf8"));
const climate = fitClimate(readingsFrom(rows));

interface Fixture {
  week: number;
  home: string;
  away: string;
  hour: number;
  indoors: boolean;
  /** what actually happened, and what the market said would */
  homeScore: number;
  awayScore: number;
  line?: number;
  total?: number;
}

const fixtures: Fixture[] = [];

for (const r of rows) {
  if (r["game_type"] !== "REG" || Number(r["season"]) !== SEASON) {
    continue;
  }

  const homeScore = Number(r["home_score"]);
  const awayScore = Number(r["away_score"]);

  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) {
    continue;
  }

  const hour = Number((r["gametime"] ?? "").split(":")[0]);
  const roof = r["roof"] ?? "";
  const line = Number(r["spread_line"]);
  const total = Number(r["total_line"]);

  fixtures.push({
    week: Number(r["week"]),
    home: r["home_team"] ?? "", away: r["away_team"] ?? "",
    hour: Number.isFinite(hour) ? hour : 13,
    indoors: roof === "dome" || roof === "closed",
    homeScore, awayScore,
    line: Number.isFinite(line) ? line : undefined,
    total: Number.isFinite(total) ? total : undefined,
  });
}

console.log(`playing ${fixtures.length} fixtures ${RUNS} times over...`);

const rng = seededRng(53);
const said = new Map<number, { home: number; away: number }>();

fixtures.forEach((f, i) => {
  const home = world.sideFor(f.home);
  const away = world.sideFor(f.away);

  if (!home || !away) {
    return;
  }

  let homePoints = 0;
  let awayPoints = 0;

  for (let run = 0; run < RUNS; run++) {
    const where = HOME[f.home];
    const venue = f.indoors || where?.indoors
      ? { indoors: true }
      : {
          indoors: false,
          temperature: climate.drawTemperature(f.home, f.week, f.hour, rng),
          wind: climate.drawWind(f.home, rng),
        };
    const game = playGame(home as Side, away as Side, {
      rules: {
        ...world.rules,
        kickSucceeds: world.kicking.kickSucceeds,
        kickHere: (yardline: number) => kickingVenue.bend(yardline, venue),
        kickAppetite: kickingVenue.appetite(venue),
      },
      fourth: world.fourth,
      clock: { isLast: world.kicking.isLast, lastLength: world.kicking.lastLength },
      ticking: world.ticking,
      week: f.week,
    }, rng);

    homePoints += game.points[f.home] ?? 0;
    awayPoints += game.points[f.away] ?? 0;
  }

  said.set(i, { home: homePoints / RUNS, away: awayPoints / RUNS });
});

/** the margin from the home side, which is how a line is written */
interface Pair { walk: number; vegas: number; was: number }

const margins: Pair[] = [];
const totals: Pair[] = [];

fixtures.forEach((f, i) => {
  const mine = said.get(i);

  if (!mine || f.line === undefined || f.total === undefined) {
    return;
  }

  margins.push({
    walk: mine.home - mine.away,
    vegas: f.line,
    was: f.homeScore - f.awayScore,
  });
  totals.push({
    walk: mine.home + mine.away,
    vegas: f.total,
    was: f.homeScore + f.awayScore,
  });
});

const level = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

console.log(`\nOver ${margins.length} fixtures of ${SEASON}, points off.\n`);
console.log("                      the walk    vegas    saying nothing");

const flatMargin = new Array(margins.length).fill(level(margins.map((p) => p.was)));
const flatTotal = new Array(totals.length).fill(level(totals.map((p) => p.was)));

console.log(
  `  the margin          ${rmse(margins.map((p) => p.walk), margins.map((p) => p.was)).toFixed(2).padStart(8)}  ` +
  `${rmse(margins.map((p) => p.vegas), margins.map((p) => p.was)).toFixed(2).padStart(7)}  ` +
  `${rmse(flatMargin, margins.map((p) => p.was)).toFixed(2).padStart(14)}`,
);
console.log(
  `  the total           ${rmse(totals.map((p) => p.walk), totals.map((p) => p.was)).toFixed(2).padStart(8)}  ` +
  `${rmse(totals.map((p) => p.vegas), totals.map((p) => p.was)).toFixed(2).padStart(7)}  ` +
  `${rmse(flatTotal, totals.map((p) => p.was)).toFixed(2).padStart(14)}`,
);

/** how often each of them had the right side of it */
const rightSide = (of: (p: Pair) => number) =>
  margins.filter((p) => of(p) * p.was > 0).length / margins.filter((p) => p.was !== 0).length;

console.log(`\n  picked the winner: the walk ${(100 * rightSide((p) => p.walk)).toFixed(1)}%, ` +
  `vegas ${(100 * rightSide((p) => p.vegas)).toFixed(1)}%`);

console.log(`\n  the walk's own level: ${level(totals.map((p) => p.walk)).toFixed(1)} points a game ` +
  `against ${level(totals.map((p) => p.was)).toFixed(1)} really scored`);
