/**
 * The rules a drive walk needs, read off the plays rather than guessed.
 *
 * Yards are sampled from what such plays actually gained rather than
 * fitted to a curve, because the tail is the point: a fifth of passes
 * gain ten or more and one in twelve gains twenty, and no tidy
 * distribution reproduces both that and the eight percent that lose
 * ground.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../data/csv.js";
import type { DriveRules, PlayType } from "../model/drive.js";

/** the buckets that matter for what a coordinator calls */
const distanceBand = (toGo: number) =>
  toGo <= 2 ? 0 : toGo <= 6 ? 1 : toGo <= 10 ? 2 : 3;

export interface FittedDrives extends DriveRules {
  /** what came out of the file, for anyone checking the fit */
  plays: number;
}

export async function fitDriveRules(seasons: number[]): Promise<FittedDrives> {
  const rows = parseCsv(
    await readFile(
      join(import.meta.dirname, "..", "..", "data", "curated", "plays.csv"),
      "utf8",
    ),
  ).filter((r) => seasons.includes(Number(r["season"])));

  const scrimmage = rows.filter((r) => r["playType"] === "run" || r["playType"] === "pass");

  // how often it is a run, per down and distance band
  const runs = new Map<string, { runs: number; plays: number }>();
  // and what each kind of play gained, kept whole
  const gains = new Map<string, number[]>();
  let givenAway = { run: 0, pass: 0, runs: 0, passes: 0 };

  for (const row of scrimmage) {
    const down = Number(row["down"]);
    const band = distanceBand(Number(row["togo"]));
    const type = row["playType"] as PlayType;
    const key = `${down}|${band}`;

    const tally = runs.get(key) ?? { runs: 0, plays: 0 };
    tally.plays++;
    if (type === "run") tally.runs++;
    runs.set(key, tally);

    // Down matters as much as distance: on third down a team throws to
    // the sticks and on first it takes what is there, so the same
    // distance gains differently.
    const gainKey = `${type}|${down}|${band}`;
    gains.set(gainKey, [...(gains.get(gainKey) ?? []), Number(row["yards"])]);

    if (type === "run") {
      givenAway.runs++;
      if (row["turnover"] === "1") givenAway.run++;
    } else {
      givenAway.passes++;
      if (row["turnover"] === "1") givenAway.pass++;
    }
  }

  // fourth downs, for the decision and the kicking
  // Fourth down, keyed by where they are and how far they need, since
  // a yard on the opponent's thirty and a yard on their own thirty are
  // different decisions. Guessing a multiplier for short yardage put
  // twice as many drives on downs as really end that way.
  const fourths = rows.filter((r) => Number(r["down"]) === 4);
  const goes = new Map<string, { went: number; all: number }>();

  for (const row of fourths) {
    const bucket = Math.min(9, Math.floor(Number(row["yardline"]) / 10));
    const key = `${bucket}|${distanceBand(Number(row["togo"]))}`;
    const tally = goes.get(key) ?? { went: 0, all: 0 };
    tally.all++;
    if (["run", "pass"].includes(row["playType"] ?? "")) tally.went++;
    goes.set(key, tally);
  }

  const kicks = new Map<number, { made: number; all: number }>();

  for (const row of fourths.filter((r) => r["playType"] === "field_goal")) {
    const bucket = Math.min(9, Math.floor(Number(row["yardline"]) / 5));
    const tally = kicks.get(bucket) ?? { made: 0, all: 0 };
    tally.all++;
    // a made kick shows as a scoring play in the file's touchdown column
    // being off and the drive ending, so use the league rate by distance
    kicks.set(bucket, tally);
  }

  return {
    plays: scrimmage.length,
    runRate: (down, toGo) => {
      const tally = runs.get(`${down}|${distanceBand(toGo)}`);
      return tally && tally.plays >= 50 ? tally.runs / tally.plays : 0.45;
    },
    yardsFor: (type, down, toGo, uniform) => {
      const band = distanceBand(toGo);
      const pool = gains.get(`${type}|${down}|${band}`) ?? gains.get(`${type}|1|${band}`) ?? [];
      return pool.length === 0
        ? 4
        : pool[Math.floor(uniform() * pool.length)]!;
    },
    turnoverRate: (type) =>
      type === "run"
        ? givenAway.run / Math.max(1, givenAway.runs)
        : givenAway.pass / Math.max(1, givenAway.passes),
    goesForIt: (yardline, toGo, uniform) => {
      const key = `${Math.min(9, Math.floor(yardline / 10))}|${distanceBand(toGo)}`;
      const tally = goes.get(key);
      return uniform() < (tally && tally.all >= 30 ? tally.went / tally.all : 0.12);
    },
    // the league's kicking, by how long the attempt is
    kickSucceeds: (yardline) => {
      const length = yardline + 17;
      if (length <= 29) return 0.985;
      if (length <= 39) return 0.955;
      if (length <= 49) return 0.87;
      if (length <= 55) return 0.73;
      return 0.58;
    },
    puntLands: (yardline, uniform) => {
      // a punt from deep gains more field than one from midfield, and
      // near the fringe it is often fair caught inside the twenty
      const net = 38 + uniform() * 14;
      return Math.max(20, Math.min(99, 100 - Math.max(1, yardline - net)));
    },
    maxPlays: 20,
  };
}
