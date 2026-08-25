/**
 * The fitted source against the walked one, on a season we can mark.
 *
 * The board predicts a man's stats with a regression per stat and
 * spreads his season across his weeks with a multiplier. The walk plays
 * the fixtures instead. This runs both at a season already played and
 * scores them the same way, so switching is a decision with a number
 * behind it.
 *
 * Run: npx tsx scripts/sourceCompare.ts [season]
 */

import { loadGames, loadPlayerStats } from "../src/data/nflverse.js";
import { buildWorld } from "../src/features/playedWorld.js";
import { walkSeason, type Fixture } from "../src/features/walkedSeason.js";
import { fitClimate } from "../src/features/climate.js";
import { readingsFrom, kickoffsIn } from "../src/data/gameWeather.js";
import { parseCsv } from "../src/data/csv.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { seededRng } from "../src/sim/rng.js";
import { spearman, rmse } from "../src/backtest/metrics.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { StatParts } from "../src/features/seasonSummary.js";

const SEASON = Number(process.argv[2] ?? 2024);
const RUNS = Number(process.env["RUNS"] ?? 20);
const RULES = presets.ppr;
const POSITIONS = ["QB", "RB", "WR", "TE"];

const positions = new Map<string, string>();
const namesOf = new Map<string, string>();

for (const s of await loadPlayerStats(SEASON - 1)) {
  positions.set(s.playerId, s.position);
  namesOf.set(s.playerId, s.playerName);
}

console.log(`building the world as it looked before ${SEASON}...`);
const world = await buildWorld(SEASON, 1, false, positions);

const rows = parseCsv(await readFile(
  join(import.meta.dirname, "..", "data", "raw", "games.csv"), "utf8"));
const climate = fitClimate(readingsFrom(rows));
const fixtures: Fixture[] = kickoffsIn(rows, SEASON).map((k) => ({
  week: k.week, homeTeam: k.homeTeam, awayTeam: k.awayTeam,
  hour: k.hour, indoors: k.indoors,
  homeRest: k.homeRest, awayRest: k.awayRest,
}));

console.log(`playing ${fixtures.length} fixtures ${RUNS} times over...`);
const walked = walkSeason(
  world, fixtures,
  { runs: RUNS, gamesFor: () => 17, climate },
  seededRng(23),
);

/** what each man actually did that season */
const truth = new Map<string, { points: number; games: number; parts: StatParts }>();

for (const s of await loadPlayerStats(SEASON)) {
  if (s.week > 18) {
    continue;
  }

  const so = truth.get(s.playerId) ?? {
    points: 0, games: 0,
    parts: {
      passYds: 0, passTd: 0, interceptions: 0, rushYds: 0, rushTd: 0,
      receptions: 0, recYds: 0, recTd: 0,
      passAtt: 0, passCmp: 0, carries: 0, targets: 0,
    },
  };
  so.points += fantasyPoints(s.statLine, RULES);
  so.games++;
  so.parts.carries += s.carries;
  so.parts.targets += s.targets;
  so.parts.passAtt += s.passing.attempts;
  so.parts.passCmp += s.passing.completions;
  so.parts.rushYds += s.statLine.rushYds;
  so.parts.recYds += s.statLine.recYds;
  so.parts.receptions += s.statLine.receptions;
  truth.set(s.playerId, so);
}

const pointsOf = (parts: StatParts) => fantasyPoints({
  passYds: parts.passYds, passTd: parts.passTd,
  interceptions: parts.interceptions,
  rushYds: parts.rushYds, rushTd: parts.rushTd,
  receptions: parts.receptions, recYds: parts.recYds, recTd: parts.recTd,
  fumblesLost: 0, twoPointConversions: 0,
}, RULES);

console.log(`\nHow the walk did on ${SEASON}, per game, against what happened.\n`);
console.log("        n    order   points off   carries off   targets off");

for (const position of POSITIONS) {
  const pairs: { said: number; was: number; carSaid: number; carWas: number;
    tgtSaid: number; tgtWas: number }[] = [];

  for (const [playerId, lines] of walked) {
    if (positions.get(playerId) !== position) {
      continue;
    }

    const his = truth.get(playerId);

    if (!his || his.games < 8) {
      continue;
    }

    pairs.push({
      said: pointsOf(lines.perGame),
      was: his.points / his.games,
      carSaid: lines.perGame.carries,
      carWas: his.parts.carries / his.games,
      tgtSaid: lines.perGame.targets,
      tgtWas: his.parts.targets / his.games,
    });
  }

  if (pairs.length < 5) {
    console.log(`  ${position.padEnd(4)} too few to say`);
    continue;
  }

  const order = spearman(pairs.map((p) => p.said), pairs.map((p) => p.was));
  const off = rmse(pairs.map((p) => p.said), pairs.map((p) => p.was));
  const carOff = rmse(pairs.map((p) => p.carSaid), pairs.map((p) => p.carWas));
  const tgtOff = rmse(pairs.map((p) => p.tgtSaid), pairs.map((p) => p.tgtWas));

  console.log(
    `  ${position.padEnd(4)} ${String(pairs.length).padStart(4)}   ` +
    `${order.toFixed(3)}   ${off.toFixed(2).padStart(10)}   ` +
    `${carOff.toFixed(2).padStart(11)}   ${tgtOff.toFixed(2).padStart(11)}`,
  );
}

console.log("\nAnd what it says a week looks like, which is the point of it:\n");

const swings: number[] = [];

for (const [playerId, lines] of walked) {
  if (!POSITIONS.includes(positions.get(playerId) ?? "") || lines.byWeek.length < 10) {
    continue;
  }

  const points = lines.byWeek.map((w) => pointsOf(w.parts)).filter((p) => p > 0);

  if (points.length >= 10) {
    swings.push(Math.max(...points) / Math.min(...points));
  }
}

swings.sort((a, b) => a - b);
console.log(`  best week over worst, median ${swings[swings.length >> 1]?.toFixed(3)}`);
console.log(`  (the fitted source ships about 1.10 for a back and 1.15 for a receiver)`);
