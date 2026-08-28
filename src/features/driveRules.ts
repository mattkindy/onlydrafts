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
  /**
   * A pass that was caught, on its own. The ordinary pass pool has the
   * incompletions in it, a third of the plays at nought yards, so
   * anything that decides the catch for itself has to draw from this
   * one instead or it drops the ball twice.
   */
  caughtYards: (
    down: number, toGo: number, yardline: number, uniform: () => number,
  ) => number;
  /** what an average touch gains, for scaling a player against */
  means: { carry: number; caught: number };
  /**
   * How often a throw ends with the passer on the floor, and how much
   * it costs. Anything that decides the catch for itself skips the
   * ordinary pass pool, and these go with it, or a drive can never lose
   * ground through the air.
   */
  sackRate: number;
  sackYards: (uniform: () => number) => number;
}

type Row = Record<string, string>;

/** the curated plays for these seasons, read once */
export async function loadDrivePlays(
  seasons: number[],
  /** in season, the weeks of the current year already played */
  current?: { season: number; beforeWeek: number },
): Promise<Row[]> {
  return parseCsv(
    await readFile(
      join(import.meta.dirname, "..", "..", "data", "curated", "plays.csv"),
      "utf8",
    ),
  ).filter((r) =>
    seasons.includes(Number(r["season"])) ||
    (current !== undefined &&
      Number(r["season"]) === current.season &&
      Number(r["week"]) < current.beforeWeek));
}

/**
 * Rules from a set of plays, falling back to another set wherever this
 * one is too thin to believe.
 *
 * One team over three seasons has about three thousand plays, which cut
 * by kind, down and distance leaves under a hundred in most cells and
 * a handful in some. Where that happens the league's plays are used
 * instead, so a team is its own only where it has shown enough to be.
 */
export function rulesFrom(rows: Row[], fallback?: FittedDrives): FittedDrives {
  const scrimmage = rows.filter((r) => r["playType"] === "run" || r["playType"] === "pass");
  // A defensive penalty that moves the chains keeps a drive alive
  // without the offence doing anything, and leaving it out is part of
  // why the walk stalled more often than drives really do.
  const flagged = rows.filter((r) => r["playType"] === "penalty");
  const penaltyYards = flagged.map((r) => Number(r["yards"]) || 0);

  // how often it is a run, per down and distance band
  const runs = new Map<string, { runs: number; plays: number }>();
  // What each kind of play gained, kept whole and kept where it
  // happened. Bucketing the field threw away that the two yard line
  // scores six times as often as the eighteen.
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
    const gainKey = `${type}|${down}|${band}|${Math.min(99, Number(row["yardline"]))}`;
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

  const ENOUGH = 40;

  /**
   * The plays run from around here, widening out from the spot until
   * there are enough of them to draw from.
   *
   * A window that grows only as far as it must keeps the goal line
   * apart from the eighteen, where there is plenty of history, and
   * still finds something to draw from on fourth and nineteen at the
   * forty seven, where there is not.
   */
  const found = new Map<string, number[]>();
  const nearby = (pools: Map<string, number[]>, at: string, yardline: number) => {
    const seen = found.get(`${at}|${yardline}`);

    if (seen) {
      return seen;
    }

    let pool: number[] = [];

    for (const reach of [1, 2, 4, 7, 12, 20, 35, 60, 99]) {
      pool = [];

      for (let yard = yardline - reach; yard <= yardline + reach; yard++) {
        if (yard < 1 || yard > 99) {
          continue;
        }

        const here = pools.get(`${at}|${yard}`);

        if (here) {
          pool = pool.concat(here);
        }
      }

      if (pool.length >= ENOUGH) {
        break;
      }
    }

    found.set(`${at}|${yardline}`, pool);
    return pool;
  };

  const caught = new Map<string, number[]>();

  for (const row of scrimmage) {
    if (row["playType"] !== "pass") {
      continue;
    }

    const gained = Number(row["yards"]);

    if (gained <= 0) {
      continue;
    }

    const key = `${Number(row["down"])}|${distanceBand(Number(row["togo"]))}`;
    caught.set(key, [...(caught.get(key) ?? []), gained]);
  }

  const everyCatch = [...caught.values()].flat();
  const passes = scrimmage.filter((r) => r["playType"] === "pass");
  const sacks = passes
    .map((r) => Number(r["yards"])).filter((gained) => gained < 0);
  const everyCarry = scrimmage
    .filter((r) => r["playType"] === "run").map((r) => Number(r["yards"]));
  const average = (values: number[]) =>
    values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

  return {
    plays: scrimmage.length,
    penaltyFirstDown: flagged.length >= ENOUGH || !fallback
      ? flagged.length / Math.max(1, scrimmage.length + flagged.length)
      : fallback.penaltyFirstDown,
    penaltyYards: (uniform) =>
      penaltyYards.length < ENOUGH && fallback
        ? fallback.penaltyYards(uniform)
        : penaltyYards.length === 0
          ? 10
          : penaltyYards[Math.floor(uniform() * penaltyYards.length)]!,
    runRate: (down, toGo) => {
      const tally = runs.get(`${down}|${distanceBand(toGo)}`);

      if (tally && tally.plays >= 50) {
        return tally.runs / tally.plays;
      }

      return fallback ? fallback.runRate(down, toGo) : 0.45;
    },
    yardsFor: (type, down, toGo, yardline, uniform) => {
      const pool = nearby(
        gains, `${type}|${down}|${distanceBand(toGo)}`, yardline,
      );

      if (pool.length) {
        return pool[Math.floor(uniform() * pool.length)]!;
      }

      return fallback ? fallback.yardsFor(type, down, toGo, yardline, uniform) : 4;
    },
    caughtYards: (down, toGo, yardline, uniform) => {
      const pool = nearby(caught, `${down}|${distanceBand(toGo)}`, yardline);

      if (pool.length) {
        return pool[Math.floor(uniform() * pool.length)]!;
      }

      if (fallback) {
        return fallback.caughtYards(down, toGo, yardline, uniform);
      }

      return everyCatch.length
        ? everyCatch[Math.floor(uniform() * everyCatch.length)]!
        : 11;
    },
    means: {
      carry: everyCarry.length >= ENOUGH || !fallback
        ? average(everyCarry)
        : fallback.means.carry,
      caught: everyCatch.length >= ENOUGH || !fallback
        ? average(everyCatch)
        : fallback.means.caught,
    },
    sackRate: passes.length >= ENOUGH || !fallback
      ? sacks.length / Math.max(1, passes.length)
      : fallback.sackRate,
    sackYards: (uniform) =>
      sacks.length < ENOUGH && fallback
        ? fallback.sackYards(uniform)
        : sacks.length === 0
          ? -7
          : sacks[Math.floor(uniform() * sacks.length)]!,
    turnoverRate: (type) => {
      const seen = type === "run" ? givenAway.runs : givenAway.passes;

      if (seen < 200 && fallback) {
        return fallback.turnoverRate(type);
      }

      return type === "run"
        ? givenAway.run / Math.max(1, givenAway.runs)
        : givenAway.pass / Math.max(1, givenAway.passes);
    },
    goesForIt: (yardline, toGo, uniform) => {
      const key = `${Math.min(9, Math.floor(yardline / 10))}|${distanceBand(toGo)}`;
      const tally = goes.get(key);

      if (tally && tally.all >= 30) {
        return uniform() < tally.went / tally.all;
      }

      return fallback
        ? fallback.goesForIt(yardline, toGo, uniform)
        : uniform() < 0.12;
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
      /**
       * Two different kicks. With the whole field a punter swings away
       * and nets about 43 with the return off. Inside the other side's
       * half he aims to pin instead, and where the ball dies depends on
       * where he stood. Both halves are set to where the next drive
       * started after punts in 2022 to 2024, which the old fixed net
       * missed by two to six yards deep at every spot.
       */
      const lands = yardline >= 62
        ? yardline - (36 + uniform() * 14)
        : 0.36 * yardline - 4 + (uniform() - 0.5) * 14;

      return lands <= 0
        ? 80
        : Math.max(1, Math.min(99, Math.round(100 - lands)));
    },
    maxPlays: 20,
  };
}

export async function fitDriveRules(seasons: number[]): Promise<FittedDrives> {
  return rulesFrom(await loadDrivePlays(seasons));
}

/**
 * One set of rules per offence, each falling back to the league's.
 *
 * Without this the walk has no idea who is playing, so every team plays
 * the same game and predicting one in particular is out of reach.
 */
export async function fitTeamDriveRules(
  seasons: number[],
  current?: { season: number; beforeWeek: number },
): Promise<{ league: FittedDrives; byTeam: Map<string, FittedDrives> }> {
  const rows = await loadDrivePlays(seasons, current);
  const league = rulesFrom(rows);
  const byOffence = new Map<string, Row[]>();

  for (const row of rows) {
    const team = row["offense"] ?? "";

    if (!team) {
      continue;
    }

    byOffence.set(team, [...(byOffence.get(team) ?? []), row]);
  }

  return {
    league,
    byTeam: new Map(
      [...byOffence].map(([team, own]) => [team, rulesFrom(own, league)]),
    ),
  };
}
