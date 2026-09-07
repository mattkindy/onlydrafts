/**
 * How close is a simulated drive to the one that really happened?
 *
 * Other benches score a season of totals, where a simulator that is
 * too averaged still lands in the right place. This puts the walk in
 * one known state, the opening drive of a half, plays it two hundred
 * times, and scores what came out against the drive that followed:
 * how it ended, how long it was, what the first snap was.
 *
 * The walk's rules see all four seasons and its rivals do not see the
 * season they are scored on, so any edge here runs the walk's way.
 *
 * Run: npx tsx scripts/gameRealismEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import {
  brierScore, calibrationTable, flatnessOf, logScore, randomisedPercentile,
} from "../src/backtest/calibration.js";
import { fitTeamDriveRules } from "../src/features/driveRules.js";
import { simulateDrive, type Drive, type DriveEnd } from "../src/model/drive.js";
import { seededRng } from "../src/sim/rng.js";

const FITTED_ON = [2022, 2023, 2024, 2025];
const SCORED = [2023, 2024, 2025];
const RUNS = Number(process.env["RUNS"] ?? 200);

const ENDINGS = ["touchdown", "fieldGoal", "punt", "turnover", "endOfHalf"] as const;
type Ending = (typeof ENDINGS)[number];

/** what the release calls a drive result, in the walk's five words */
const REAL_ENDINGS: Record<string, Ending> = {
  "Touchdown": "touchdown",
  "Field goal": "fieldGoal",
  "Punt": "punt",
  "Turnover": "turnover",
  "Turnover on downs": "turnover",
  "Missed field goal": "turnover",
  "Opp touchdown": "turnover",
  "Safety": "turnover",
  "End of half": "endOfHalf",
  "End of game": "endOfHalf",
};

const WALK_ENDINGS: Record<DriveEnd, Ending> = {
  touchdown: "touchdown",
  fieldGoal: "fieldGoal",
  punt: "punt",
  missedKick: "turnover",
  downs: "turnover",
  turnover: "turnover",
  clock: "endOfHalf",
};

interface Opening {
  season: number;
  offense: string;
  half: number;
  startYard: number;
  ended: Ending;
  plays: number;
  netYards: number;
  ranIt: boolean;
  firstYards: number;
  spread: number;
  total: number;
}

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

const spreadOf = (values: number[]) => {
  const mid = middle(values);
  return Math.sqrt(middle(values.map((v) => (v - mid) ** 2)));
};

/** ten yard bands of where the drive started, which is the rival's memory */
const bandOf = (startYard: number) => Math.min(9, Math.floor(startYard / 10));

async function loadOpenings(): Promise<Opening[]> {
  const text = await readFile(
    join(import.meta.dirname, "..", "data", "curated", "openingDrives.csv"), "utf8",
  );

  return parseCsv(text).flatMap((row) => {
    const ended = REAL_ENDINGS[row["result"] ?? ""];

    if (!ended) {
      return [];
    }

    return [{
      season: Number(row["season"]),
      offense: row["offense"] ?? "",
      half: Number(row["half"]),
      startYard: Number(row["startYard"]),
      ended,
      plays: Number(row["plays"]),
      netYards: Number(row["netYards"]),
      ranIt: row["firstCall"] === "run",
      firstYards: Number(row["firstYards"]),
      spread: Number(row["spread"]),
      total: Number(row["total"]),
    }];
  });
}

/** what the walk produced for one drive, kept whole rather than averaged */
interface Played {
  endings: number[];
  plays: number[];
  netYards: number[];
  ranIt: number;
  firstYards: number[];
}

/**
 * Counts turned into probabilities with half a run added to every
 * outcome, so a walk that never once punted from the two does not take
 * an infinite log score for the one drive that did.
 */
const smoothed = (counts: number[], seen: number) =>
  counts.map((count) => (count + 0.5) / (seen + 0.5 * counts.length));

const featuresOf = (drive: Opening) => [
  1, drive.startYard / 100, drive.spread / 14, drive.total / 45, drive.half - 1,
];

/**
 * A softmax fitted by gradient descent, standing in for the best read
 * of a drive available from what anyone knows before it starts.
 */
function fitSoftmax(
  rows: { x: number[]; y: number }[], classes: number, steps = 400, rate = 0.6,
): (x: number[]) => number[] {
  const width = rows[0]?.x.length ?? 0;
  const weights = Array.from(
    { length: classes }, () => new Array<number>(width).fill(0),
  );

  const say = (x: number[]) => {
    const raw = weights.map((w) => w.reduce((total, wi, i) => total + wi * x[i]!, 0));
    const top = Math.max(...raw);
    const exp = raw.map((v) => Math.exp(v - top));
    const sum = exp.reduce((a, b) => a + b, 0);
    return exp.map((v) => v / sum);
  };

  for (let step = 0; step < steps; step++) {
    const grad = Array.from(
      { length: classes }, () => new Array<number>(width).fill(0),
    );

    for (const row of rows) {
      const said = say(row.x);

      for (let k = 0; k < classes; k++) {
        const error = said[k]! - (k === row.y ? 1 : 0);

        for (let i = 0; i < width; i++) {
          grad[k]![i] = grad[k]![i]! + error * row.x[i]!;
        }
      }
    }

    for (let k = 0; k < classes; k++) {
      for (let i = 0; i < width; i++) {
        weights[k]![i] = weights[k]![i]! - (rate / rows.length) * grad[k]![i]!;
      }
    }
  }

  return say;
}

/**
 * How far the ball moved, read off the last snap rather than summed
 * over the gains, so that the yards a defensive flag handed over are
 * in it. The drives that happened count them and a sum of gains
 * would not.
 */
function groundMade(startYard: number, walked: Drive): number {
  const last = walked.plays[walked.plays.length - 1];

  if (walked.ending === "touchdown") {
    return startYard;
  }

  return last ? startYard - (last.state.yardline - last.yards) : 0;
}

function hashOf(text: string): number {
  let hash = 17;

  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) % 2147483647;
  }

  return hash;
}

function scoreEndings(
  drives: Opening[], saidBy: Map<Opening, number[]>[], names: string[],
): void {
  console.log("how the drive ended            brier      log   says touchdown");

  for (let i = 0; i < saidBy.length; i++) {
    const said = drives.map((d) => saidBy[i]!.get(d)!);
    const was = drives.map((d) => ENDINGS.indexOf(d.ended));

    console.log(
      "  " + names[i]!.padEnd(24) +
      middle(said.map((p, at) => brierScore(p, was[at]!))).toFixed(4).padStart(7) +
      middle(said.map((p, at) => logScore(p, was[at]!))).toFixed(4).padStart(9) +
      (middle(said.map((p) => p[0]!)) * 100).toFixed(1).padStart(12) + "%",
    );
  }

  const rateOf = (ending: Ending) =>
    drives.filter((d) => d.ended === ending).length / drives.length;

  console.log(
    "  " + "what happened".padEnd(24) + "      -        -" +
    (rateOf("touchdown") * 100).toFixed(1).padStart(12) + "%",
  );

  console.log("\nwhere each ending went\n");
  console.log(
    "                      touchdown  field goal      punt  turnover  end of half",
  );

  const line = (label: string, shares: number[]) =>
    console.log(
      "  " + label.padEnd(20) +
      shares.map((s) => (s * 100).toFixed(1).padStart(9) + "%").join(""),
    );

  for (let i = 0; i < saidBy.length; i++) {
    const said = drives.map((d) => saidBy[i]!.get(d)!);
    line(names[i]!, ENDINGS.map((_, k) => middle(said.map((p) => p[k]!))));
  }

  line("what happened", ENDINGS.map(rateOf));
}

function scoreLength(
  label: string, real: (d: Opening) => number,
  drives: Opening[], pools: Map<Opening, number[]>[], names: string[],
): void {
  const rng = seededRng(hashOf(label));
  console.log(`\n${label}: where the one that happened landed in the spread\n`);
  console.log(
    "                       real      sim   real sd    sim sd" +
    "    tails   middle   drift",
  );

  for (let i = 0; i < pools.length; i++) {
    const percentiles = drives.map((d) =>
      randomisedPercentile(pools[i]!.get(d)!, real(d), rng));
    const flat = flatnessOf(percentiles);
    const sim = drives.flatMap((d) => pools[i]!.get(d)!);

    console.log(
      "  " + names[i]!.padEnd(20) +
      middle(drives.map(real)).toFixed(2).padStart(7) +
      middle(sim).toFixed(2).padStart(9) +
      spreadOf(drives.map(real)).toFixed(2).padStart(10) +
      spreadOf(sim).toFixed(2).padStart(10) +
      (flat.tails * 100).toFixed(1).padStart(8) + "%" +
      (flat.middle * 100).toFixed(1).padStart(8) + "%" +
      flat.drift.toFixed(3).padStart(8),
    );
    console.log(
      "    tenths  " + flat.deciles.map((s) => (s * 100).toFixed(1).padStart(5)).join(""),
    );
  }

  console.log("  flat would be 10.0% tails, 20.0% middle, .000 drift");
}

async function main(): Promise<void> {
  const openings = await loadOpenings();
  const scored = openings.filter((d) => SCORED.includes(d.season));
  console.log(
    `${scored.length} opening drives over ${SCORED.join(", ")}, ` +
    `${RUNS} walks of each\n`,
  );

  const { league, byTeam } = await fitTeamDriveRules(FITTED_ON);
  console.log(`rules from ${league.plays} plays\n`);

  const played = new Map<Opening, Played>();

  for (const drive of scored) {
    const rules = byTeam.get(drive.offense) ?? league;
    const rng = seededRng(
      hashOf(`${drive.season}|${drive.offense}|${drive.half}|${drive.startYard}`),
    );
    const out: Played = {
      endings: new Array<number>(ENDINGS.length).fill(0),
      plays: [], netYards: [], ranIt: 0, firstYards: [],
    };

    for (let run = 0; run < RUNS; run++) {
      const walked = simulateDrive(drive.startYard, rules, rng);
      out.endings[ENDINGS.indexOf(WALK_ENDINGS[walked.ending])]!++;
      out.plays.push(walked.plays.length);
      out.netYards.push(groundMade(drive.startYard, walked));
      const first = walked.plays[0];

      if (first) {
        if (first.type === "run") {
          out.ranIt++;
        }

        out.firstYards.push(first.yards);
      }
    }

    played.set(drive, out);
  }

  const bandRows = new Map<string, Opening[]>();

  for (const drive of openings) {
    const key = `${drive.season}|${bandOf(drive.startYard)}|${drive.half}`;
    bandRows.set(key, [...(bandRows.get(key) ?? []), drive]);
  }

  // the rival: what drives from this band of the field, in this half,
  // did in the three seasons that are not being scored
  const bandFor = (drive: Opening) =>
    FITTED_ON.filter((s) => s !== drive.season)
      .flatMap((s) => bandRows.get(`${s}|${bandOf(drive.startYard)}|${drive.half}`) ?? []);

  const fitted = new Map<number, (x: number[]) => number[]>();
  const fittedCall = new Map<number, (x: number[]) => number[]>();

  for (const season of SCORED) {
    const rows = openings.filter((d) => d.season !== season);
    fitted.set(season, fitSoftmax(
      rows.map((d) => ({ x: featuresOf(d), y: ENDINGS.indexOf(d.ended) })),
      ENDINGS.length,
    ));
    fittedCall.set(season, fitSoftmax(
      rows.map((d) => ({ x: featuresOf(d), y: d.ranIt ? 0 : 1 })), 2,
    ));
  }

  const walkSays = new Map<Opening, number[]>();
  const bandSays = new Map<Opening, number[]>();
  const fitSays = new Map<Opening, number[]>();

  for (const drive of scored) {
    walkSays.set(drive, smoothed(played.get(drive)!.endings, RUNS));
    const band = bandFor(drive);
    bandSays.set(drive, smoothed(
      ENDINGS.map((ending) => band.filter((d) => d.ended === ending).length),
      band.length,
    ));
    fitSays.set(drive, fitted.get(drive.season)!(featuresOf(drive)));
  }

  scoreEndings(
    scored, [walkSays, bandSays, fitSays],
    ["the walk", "base rates by spot", "a fitted softmax"],
  );

  console.log("\nwhat the walk said about a touchdown, against what followed\n");
  console.log("  said          it said   it happened   drives");

  for (const row of calibrationTable(
    scored.map((d) => walkSays.get(d)![0]!),
    scored.map((d) => d.ended === "touchdown"),
    [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1],
  )) {
    console.log(
      "  " + `${(row.from * 100).toFixed(0)} to ${(row.to * 100).toFixed(0)}%`.padEnd(12) +
      (row.said * 100).toFixed(1).padStart(8) + "%" +
      (row.happened * 100).toFixed(1).padStart(12) + "%" +
      String(row.count).padStart(9),
    );
  }

  const bandPool = (pick: (d: Opening) => number) =>
    new Map(scored.map((drive) => [drive, bandFor(drive).map(pick)]));
  const walkPool = (pick: (p: Played) => number[]) =>
    new Map(scored.map((drive) => [drive, pick(played.get(drive)!)]));
  const lengthNames = ["the walk", "base rates by spot"];

  scoreLength(
    "plays a drive", (d) => d.plays, scored,
    [walkPool((p) => p.plays), bandPool((d) => d.plays)], lengthNames,
  );
  scoreLength(
    "yards a drive", (d) => d.netYards, scored,
    [walkPool((p) => p.netYards), bandPool((d) => d.netYards)], lengthNames,
  );

  console.log("\nthe first snap of the drive\n");
  console.log("                        says run   brier on the call");

  const callWays: [string, (d: Opening) => number][] = [
    ["the walk", (d) => played.get(d)!.ranIt / RUNS],
    ["base rates by spot", (d) => {
      const band = bandFor(d);
      return (band.filter((x) => x.ranIt).length + 0.5) / (band.length + 1);
    }],
    ["a fitted softmax", (d) => fittedCall.get(d.season)!(featuresOf(d))[0]!],
  ];

  for (const [label, say] of callWays) {
    const said = scored.map(say);
    console.log(
      "  " + label.padEnd(22) + (middle(said) * 100).toFixed(1).padStart(6) + "%" +
      middle(said.map((p, at) => (p - (scored[at]!.ranIt ? 1 : 0)) ** 2))
        .toFixed(4).padStart(20),
    );
  }

  console.log(
    "  " + "what happened".padEnd(22) +
    ((scored.filter((d) => d.ranIt).length / scored.length) * 100)
      .toFixed(1).padStart(6) + "%",
  );

  scoreLength(
    "yards on the first snap", (d) => d.firstYards, scored,
    [walkPool((p) => p.firstYards), bandPool((d) => d.firstYards)], lengthNames,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
