/**
 * A season played out over every core, then scored once.
 *
 * A game is about a fifth of a second and a fair number of runs over
 * a season is an hour on one core. The games do not depend on each
 * other, so this cuts them into shares, hands each share to its own
 * run of the game eval, and scores what comes back.
 *
 * Run: npx tsx scripts/playSeason.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { rmse, spearman } from "../src/backtest/metrics.js";
import { loadGames } from "../src/data/nflverse.js";
import { acrossCores, roomFor } from "../src/sim/acrossCores.js";

const SCORE_ON = 2025;

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

const spreadOf = (values: number[]) => {
  const mid = middle(values);
  return Math.sqrt(middle(values.map((v) => (v - mid) ** 2)));
};

interface FromAShare {
  said: [string, { points: number; drives: number }][];
  drive: {
    plays: number; seconds: number; count: number; startedAt: number;
    ends: [string, number][];
  };
}

async function main(): Promise<void> {
  const shares = Number(process.env["SHARES_WANTED"] ?? roomFor());
  const runs = process.env["RUNS"] ?? "60";
  console.error(
    `playing ${SCORE_ON} over ${shares} cores at ${runs} runs a game`,
  );

  const printed = await acrossCores({
    script: join(import.meta.dirname, "gamePlayEval.ts"),
    shares,
    env: { RUNS: runs },
    asTheyLand: (share) => console.error(`  share ${share} back`),
  });

  const said = new Map<string, { points: number; drives: number }>();
  const drive = {
    plays: 0, seconds: 0, count: 0, startedAt: 0,
    ends: new Map<string, number>(),
  };

  for (const line of printed) {
    const from = JSON.parse(line) as FromAShare;

    for (const [key, one] of from.said) {
      said.set(key, one);
    }

    drive.plays += from.drive.plays;
    drive.seconds += from.drive.seconds;
    drive.count += from.drive.count;
    drive.startedAt += from.drive.startedAt;

    for (const [how, n] of from.drive.ends) {
      drive.ends.set(how, (drive.ends.get(how) ?? 0) + n);
    }
  }

  // and what really happened, to score it against
  const scored = new Map<string, number>();
  const drove = new Map<string, number>();

  for (const row of parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "drives.csv"), "utf8",
  ))) {
    if (Number(row["season"]) !== SCORE_ON || Number(row["week"]) > 18) {
      continue;
    }

    const key = `${row["week"]}|${row["offense"]}`;
    scored.set(key, (scored.get(key) ?? 0) + Number(row["points"]));
    drove.set(key, (drove.get(key) ?? 0) + 1);
  }

  const line = new Map<string, number>();

  for (const game of await loadGames()) {
    if (game.season !== SCORE_ON || game.week > 18) {
      continue;
    }

    const total = game.totalLine;
    const by = game.spreadLine;

    if (total === undefined || by === undefined) {
      continue;
    }

    line.set(`${game.week}|${game.homeTeamId}`, total / 2 + by / 2);
    line.set(`${game.week}|${game.awayTeamId}`, total / 2 - by / 2);
  }

  const rows = [...said.entries()]
    .filter(([key]) => scored.has(key) && line.has(key))
    .map(([key, guess]) => ({
      guess, points: scored.get(key)!, drove: drove.get(key) ?? 0,
      priced: line.get(key)!,
    }));

  console.log(
    `\nwhat a simulated drive looks like, over ${drive.count} of them\n` +
      `  ${(drive.plays / drive.count).toFixed(1)} plays, ` +
      `${(drive.seconds / drive.count).toFixed(0)} seconds, ` +
      `starting ${(drive.startedAt / drive.count).toFixed(0)} out\n` +
      "  ends: " + [...drive.ends.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([how, n]) => `${how} ${(100 * n / drive.count).toFixed(0)}%`)
        .join(", "),
  );

  const guessed = rows.map((r) => r.guess.points);
  const truth = rows.map((r) => r.points);
  const flat = middle(truth);
  const drives = rows.map((r) => r.guess.drives);
  const reallyDrove = rows.map((r) => r.drove);
  const priced = rows.map((r) => r.priced);

  console.log(`\n${rows.length} team games\n`);
  console.log("  what                     model   always the average   order");
  console.log(
    "  points".padEnd(27) + rmse(guessed, truth).toFixed(2).padStart(6) +
      rmse(truth.map(() => flat), truth).toFixed(2).padStart(21) +
      spearman(guessed, truth).toFixed(3).padStart(8),
  );
  console.log(
    "  drives".padEnd(27) + rmse(drives, reallyDrove).toFixed(2).padStart(6) +
      rmse(reallyDrove.map(() => middle(reallyDrove)), reallyDrove)
        .toFixed(2).padStart(21) +
      spearman(drives, reallyDrove).toFixed(3).padStart(8),
  );
  console.log(
    "  points, the line".padEnd(27) + rmse(priced, truth).toFixed(2).padStart(6) +
      "".padStart(21) + spearman(priced, truth).toFixed(3).padStart(8),
  );
  console.log(
    `\n  the model says ${middle(guessed).toFixed(1)} points off ` +
      `${middle(drives).toFixed(1)} drives, ` +
      `they scored ${flat.toFixed(1)} off ${middle(reallyDrove).toFixed(1)}\n`,
  );
  console.log(
    "  how far apart it puts two team games, in points\n" +
      `    the model  ${spreadOf(guessed).toFixed(2)}\n` +
      `    the line   ${spreadOf(priced).toFixed(2)}\n` +
      `    what happened ${spreadOf(truth).toFixed(2)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
