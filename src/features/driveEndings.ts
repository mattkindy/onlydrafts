/**
 * The rest of what ends a drive, read off the plays rather than guessed.
 *
 * A play's call, who it goes to and what he gains come from the
 * factors. What is here are the things that stop a drive or keep it
 * going without the offence choosing to: a defensive flag that hands
 * over a first down, a false start or a hold that replays the down, a
 * giveaway, a punt, and the cap on how many snaps a drive is let run.
 * The kick and the clock are in `fitEndings.ts` and the fourth down
 * call in `fitFourthDown.ts`.
 *
 * This used to be `driveRules.ts`, which also kept a pool of yards by
 * down, distance and spot for the two older drive walks. They are gone,
 * and the pool and its run rate and fourth down book with them, so the
 * factors are the only yardage model left.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../data/csv.js";
import type { EndingRules } from "../model/driveFromFactors.js";
import type { Call } from "../model/playFactors.js";

/**
 * What a drive is handed besides the factors, short of the kick. Every
 * game takes its kick from `fitEndings`, with the ground's bend on it.
 */
export type DriveEndings = Required<Pick<
  EndingRules,
  | "puntLands" | "turnoverRate" | "penaltyFirstDown" | "penaltyYards"
  | "offenceFlag" | "offenceFlagYards" | "defenceFlag" | "maxPlays"
>>;

type Row = Record<string, string>;

/** the curated plays for these seasons, read once */
async function loadDrivePlays(
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

export function endingsFrom(rows: Row[]): DriveEndings {
  const scrimmage = rows.filter((r) => r["playType"] === "run" || r["playType"] === "pass");
  // A defensive penalty that moves the chains keeps a drive alive
  // without the offence doing anything, and leaving it out is part of
  // why the walk stalled more often than drives really do.
  const flagged = rows.filter((r) => r["playType"] === "penalty");
  const penaltyYards = flagged.map((r) => Number(r["yards"]) || 0);
  /**
   * Fourth down is left out of the flag rates. The rows there are
   * mostly false starts before a punt or a kick, and the walk only
   * snaps a fourth down it goes for.
   */
  const snapped = (r: Row) => Number(r["down"]) <= 3;
  const setBack = rows.filter((r) => r["playType"] === "offenceFlag" && snapped(r));
  const setBackYards = setBack.map((r) => Number(r["yards"]) || 5);
  const nudged = rows.filter((r) => r["playType"] === "defenceFlag" && snapped(r));
  const snaps = scrimmage.filter(snapped).length + flagged.filter(snapped).length +
    setBack.length + nudged.length;

  const givenAway = { run: 0, pass: 0, runs: 0, passes: 0 };

  for (const row of scrimmage) {
    if (row["playType"] === "run") {
      givenAway.runs++;
      if (row["turnover"] === "1") givenAway.run++;
    } else {
      givenAway.passes++;
      if (row["turnover"] === "1") givenAway.pass++;
    }
  }

  return {
    penaltyFirstDown:
      flagged.length / Math.max(1, scrimmage.length + flagged.length),
    penaltyYards: (uniform) =>
      penaltyYards.length === 0
        ? 10
        : penaltyYards[Math.floor(uniform() * penaltyYards.length)]!,
    offenceFlag: setBack.length / Math.max(1, snaps),
    offenceFlagYards: (uniform) =>
      setBackYards.length === 0
        ? 5
        : setBackYards[Math.floor(uniform() * setBackYards.length)]!,
    defenceFlag: nudged.length / Math.max(1, snaps),
    turnoverRate: (call: Call) =>
      call === "run"
        ? givenAway.run / Math.max(1, givenAway.runs)
        : givenAway.pass / Math.max(1, givenAway.passes),
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

/**
 * The league's endings over these seasons, and in season over the
 * weeks of this one already played.
 *
 * There is one set for the league and not one per offence. Per team
 * rules were tried at every strength of shrinkage and only added noise,
 * since the walk already carries a side through its players and the
 * market's lift; `docs/scoreboard.md` has it among what did not work.
 */
export async function fitDriveEndings(
  seasons: number[],
  current?: { season: number; beforeWeek: number },
): Promise<DriveEndings> {
  return endingsFrom(await loadDrivePlays(seasons, current));
}
