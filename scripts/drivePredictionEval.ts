/**
 * Can it pick out which drive and which game, or only the averages?
 *
 * Getting 23.6% of drives to end in a touchdown is calibration and it
 * comes almost free, because the rate was read off the same plays. The
 * question here is whether the model can tell one drive from another:
 * given where this drive started and who has the ball, is it more
 * likely to score than that one, and do a team's drives add up to the
 * points that team scored.
 *
 * Run: npx tsx scripts/drivePredictionEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { rmse, spearman } from "../src/backtest/metrics.js";
import { seededRng } from "../src/sim/rng.js";
import { loadGames } from "../src/data/nflverse.js";
import {
  fitTeamDriveRules, loadDrivePlays, rulesFrom, type FittedDrives,
} from "../src/features/driveRules.js";
import { simulateDrive } from "../src/model/drive.js";

const SCORE_ON = 2025;
const RUNS = 200;

interface RealDrive {
  week: number;
  offense: string;
  defense: string;
  startYard: number;
  result: string;
  points: number;
}

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

/** how far off a chance was, squared, which rewards being sure and right */
const brier = (said: number[], happened: number[]) =>
  middle(said.map((p, i) => (p - happened[i]!) ** 2));

/**
 * The chance a scoring drive was given a higher number than one that
 * did not score, counted over every such pair. A half is no better
 * than a coin.
 */
function auc(said: number[], happened: number[]): number {
  const order = said.map((p, i) => ({ p, hit: happened[i]! }))
    .sort((a, b) => a.p - b.p);
  let rankSum = 0;
  let hits = 0;

  for (let i = 0; i < order.length; i++) {
    if (order[i]!.hit === 1) {
      rankSum += i + 1;
      hits++;
    }
  }

  const misses = order.length - hits;

  if (hits === 0 || misses === 0) {
    return 0.5;
  }

  return (rankSum - (hits * (hits + 1)) / 2) / (hits * misses);
}

/** what the walk says about a drive from here, run many times */
function chancesFrom(
  startYard: number, rules: FittedDrives, rng: () => number,
) {
  let touchdowns = 0;
  let kicks = 0;
  let points = 0;

  for (let i = 0; i < RUNS; i++) {
    const drive = simulateDrive(startYard, rules, rng);

    if (drive.ending === "touchdown") {
      touchdowns++;
      points += 7;
    } else if (drive.ending === "fieldGoal") {
      kicks++;
      points += 3;
    }
  }

  return {
    touchdown: touchdowns / RUNS,
    fieldGoal: kicks / RUNS,
    points: points / RUNS,
  };
}

/**
 * The same predictions pulled toward their own average by however much
 * turns out to help most. A model that ranks well but scatters too
 * widely gains a lot here, and one with nothing to say gains nothing,
 * so the amount of pull is itself the answer to how much it knows.
 */
function shrunk(said: number[], truth: number[]): number[] {
  const mid = middle(said);
  let best = said;
  let bestError = Infinity;
  let bestPull = 0;

  for (let pull = 0; pull <= 1.001; pull += 0.05) {
    const tried = said.map((v) => mid + (v - mid) * (1 - pull));
    const error = rmse(tried, truth);

    if (error < bestError) {
      bestError = error;
      best = tried;
      bestPull = pull;
    }
  }

  // chosen against the same games it is scored on, so the error below
  // is the best this could possibly do rather than what it would do
  console.log(
    `  (the best pull toward the average was ${(100 * bestPull).toFixed(0)}%, ` +
      "picked on these same games)",
  );
  return best;
}

async function main(): Promise<void> {
  const drives = parseCsv(
    await readFile(
      join(import.meta.dirname, "..", "data", "curated", "drives.csv"), "utf8",
    ),
  ).map((r) => ({
    season: Number(r["season"]), week: Number(r["week"]),
    offense: r["offense"] ?? "", defense: r["defense"] ?? "",
    startYard: Number(r["startYard"]), result: r["result"] ?? "",
    points: Number(r["points"]),
  }));

  const test: RealDrive[] = drives
    .filter((d) => d.season === SCORE_ON && d.week <= 18 && d.result !== "End of half");
  const { league, byTeam } = await fitTeamDriveRules([2022, 2023, 2024]);

  // One offence against one defence has far too few plays between them
  // to fit anything, so put the offence's plays together with the ones
  // that defence gave up and draw from the pair. A good offence facing
  // a good defence then lands between the two.
  const earlier = await loadDrivePlays([2022, 2023, 2024]);
  const allowed = new Map<string, Record<string, string>[]>();
  const ran = new Map<string, Record<string, string>[]>();

  for (const row of earlier) {
    const defence = row["defense"] ?? "";
    const offence = row["offense"] ?? "";
    if (defence) allowed.set(defence, [...(allowed.get(defence) ?? []), row]);
    if (offence) ran.set(offence, [...(ran.get(offence) ?? []), row]);
  }

  const matchups = new Map<string, FittedDrives>();
  const rulesFor = (offence: string, defence: string) => {
    const key = `${offence}|${defence}`;
    const known = matchups.get(key);

    if (known) {
      return known;
    }

    const built = rulesFrom(
      [...(ran.get(offence) ?? []), ...(allowed.get(defence) ?? [])], league,
    );
    matchups.set(key, built);
    return built;
  };

  console.log(
    `${test.length} drives in ${SCORE_ON}, rules from ${league.plays} earlier plays\n`,
  );

  const rng = seededRng(7);
  const said = test.map((d) =>
    chancesFrom(d.startYard, byTeam.get(d.offense) ?? league, rng),
  );
  const scoredTouchdown = test.map((d) => (d.result === "Touchdown" ? 1 : 0));
  const baseRate = middle(scoredTouchdown);

  // the same question asked of field position alone, so the team's own
  // rules have something to beat
  const leagueSaid = test.map((d) => chancesFrom(d.startYard, league, rng));
  const matchupSaid = test.map((d) =>
    chancesFrom(d.startYard, rulesFor(d.offense, d.defense), rng),
  );

  console.log("picking out which drive ends in a touchdown");
  console.log("  model                        brier      how often it ranks right");
  for (const [label, guess] of [
    ["the league rate, always", test.map(() => baseRate)],
    ["where it started", leagueSaid.map((s) => s.touchdown)],
    ["and who has the ball", said.map((s) => s.touchdown)],
    ["and who they are playing", matchupSaid.map((s) => s.touchdown)],
  ] as [string, number[]][]) {
    console.log(
      "  " + label.padEnd(28) + brier(guess, scoredTouchdown).toFixed(4).padStart(7) +
      auc(guess, scoredTouchdown).toFixed(3).padStart(16),
    );
  }

  const actualPoints = test.map((d) => d.points);
  console.log("\npoints from one drive");
  console.log("  model                         rmse     rank");
  for (const [label, guess] of [
    ["the league average, always", test.map(() => middle(actualPoints))],
    ["where it started", leagueSaid.map((s) => s.points)],
    ["and who has the ball", said.map((s) => s.points)],
    ["and who they are playing", matchupSaid.map((s) => s.points)],
  ] as [string, number[]][]) {
    console.log(
      "  " + label.padEnd(28) + rmse(guess, actualPoints).toFixed(3).padStart(7) +
      spearman(guess, actualPoints).toFixed(3).padStart(9),
    );
  }

  // ---- games ----
  const perGame = new Map<string, { said: number; matchup: number; real: number }>();

  for (let i = 0; i < test.length; i++) {
    const drive = test[i]!;
    const key = `${drive.week}|${drive.offense}`;
    const tally = perGame.get(key) ?? { said: 0, matchup: 0, real: 0 };
    tally.said += said[i]!.points;
    tally.matchup += matchupSaid[i]!.points;
    tally.real += drive.points;
    perGame.set(key, tally);
  }

  const vegas = new Map<string, number>();

  for (const game of await loadGames()) {
    if (game.season !== SCORE_ON || game.week > 18) {
      continue;
    }

    const total = game.totalLine;
    const spread = game.spreadLine;

    if (total === undefined || spread === undefined) {
      continue;
    }

    // the line splits the total between the two, so a three point
    // favourite is expected to score a point and a half more than half
    vegas.set(`${game.week}|${game.homeTeamId}`, total / 2 + spread / 2);
    vegas.set(`${game.week}|${game.awayTeamId}`, total / 2 - spread / 2);
  }

  const games = [...perGame].map(([key, tally]) => ({
    key, ...tally, vegas: vegas.get(key),
  })).filter((g) => g.vegas !== undefined);

  console.log(`\npoints a team scores in a game, ${games.length} of them`);
  console.log("  model                         rmse     rank");
  const truth = games.map((g) => g.real);

  for (const [label, guess] of [
    ["the league average, always", games.map(() => middle(truth))],
    ["walking that team's drives", games.map((g) => g.said)],
    ["with the defence too", games.map((g) => g.matchup)],
    ["pulled toward the average", shrunk(games.map((g) => g.matchup), truth)],
    ["the betting line", games.map((g) => g.vegas!)],
  ] as [string, number[]][]) {
    console.log(
      "  " + label.padEnd(28) + rmse(guess, truth).toFixed(2).padStart(7) +
      spearman(guess, truth).toFixed(3).padStart(9),
    );
  }

  console.log(
    "\n  walking the drives says " + middle(games.map((g) => g.said)).toFixed(1) +
    " a game, the line says " + middle(games.map((g) => g.vegas!)).toFixed(1) +
    ", they really scored " + middle(truth).toFixed(1),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
