/**
 * Why does the walk not know who scores?
 *
 * A man's touchdowns are how often he gets the ball times how often
 * that reaches the end zone, so getting them wrong is one of those or
 * both. This asks the walk for both on the plays that really happened,
 * then puts the truth in each slot in turn. Whichever swap fixes the
 * ordering is the one that was breaking it.
 *
 * Run: npx tsx scripts/scoreLayerEval.ts [season]
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { buildWorld } from "../src/features/playedWorld.js";
import { seededRng } from "../src/sim/rng.js";
import { spearman } from "../src/backtest/metrics.js";

const SEASON = Number(process.argv[2] ?? 2024);
/** draws per man per play, since one is unbiased and a season adds up */
const TRIES = Number(process.env["TRIES"] ?? 6);

const positions = new Map<string, string>();

for (const s of await loadPlayerStats(SEASON - 1)) {
  positions.set(s.playerId, s.position);
}

const world = await buildWorld(SEASON, 1, false, positions);
const plays = parseCsv(await readFile(
  join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
)).filter((r) =>
  Number(r["season"]) === SEASON && ["run", "pass"].includes(r["playType"] ?? ""));

const among = new Map<string, string[]>();

for (const team of new Set(plays.map((r) => r["offense"]!))) {
  const side = world.sideFor(team);

  if (side) {
    among.set(team, side.among);
  }
}

interface Tally {
  /** the walk saying both who gets it and whether it scores */
  walk: number;
  /** the truth about who got it, the walk about whether it scored */
  hisTouches: number;
  /** the walk about who got it, the truth about whether it scored */
  hisScoring: number;
  /** and what he really did */
  was: number;
  touches: number;
  nearTouches: number;
}

const each = new Map<string, Tally>();
const mine = (id: string): Tally => {
  const own = each.get(id) ?? {
    walk: 0, hisTouches: 0, hisScoring: 0, was: 0, touches: 0, nearTouches: 0,
  };
  each.set(id, own);

  return own;
};

const rng = seededRng(29);
let saidScores = 0;
let realScores = 0;
/** where the walk's scores come from against where they really do */
const fromOut = { walk: 0, was: 0 };
/** and whether its gains run as long as the ones that happened */
const tail = { said: 0, saidLong: 0, saidHuge: 0, was: 0, wasLong: 0, wasHuge: 0 };
/**
 * How often a play from here scores at all, which is a different
 * question from which man scores. From three yards out anybody can
 * say the rate; it is who takes it in that is hard.
 */
const bandOf = (yardline: number) =>
  yardline <= 1 ? "the one" : yardline <= 3 ? "inside the three"
    : yardline <= 5 ? "inside the five" : yardline <= 10 ? "inside the ten"
    : yardline <= 20 ? "inside the twenty" : "further out";
const byBand = new Map<string, { plays: number; said: number; was: number }>();

for (const r of plays) {
  const men = among.get(r["offense"]!);
  const down = Number(r["down"]);
  const yardline = Number(r["yardline"]);

  /**
   * A down of nothing is a two point try, which is a play from the two
   * that cannot be a touchdown however it goes. There are 144 of them
   * inside the three in 2024 and they score nought, which is what made
   * a play from there look like it scores a third of the time when a
   * down of football from there scores closer to a half.
   */
  if (!men || !r["player"] || !Number.isFinite(down) || down < 1 ||
      !Number.isFinite(yardline)) {
    continue;
  }

  const state = {
    down, yardline, toGo: Number(r["togo"]),
    margin: Number(r["margin"]) || 0,
    secondsLeft: Number(r["seconds"]) || 1800,
  };
  const call = r["playType"] as "run" | "pass";
  const shares = world.factors.goesTo(state, call, men,
    { offence: r["offense"], defence: r["defense"] });
  const scored = Number(r["touchdown"]) === 1 ? 1 : 0;
  realScores += scored;
  const near = byBand.get(bandOf(yardline)) ?? { plays: 0, said: 0, was: 0 };
  near.plays++;
  near.was += scored;
  byBand.set(bandOf(yardline), near);
  const made = Number(r["yards"]) || 0;
  tail.was++;
  tail.wasLong += made >= 20 ? 1 : 0;
  tail.wasHuge += made >= 40 ? 1 : 0;

  if (scored && yardline > 20) {
    fromOut.was++;
  }

  for (const man of men) {
    const share = shares.get(man) ?? 0;
    let reached = 0;
    let long = 0;
    let huge = 0;

    for (let i = 0; i < TRIES; i++) {
      const drawn = world.factors.gains(state, call, man, rng, {
        offence: r["offense"], defence: r["defense"], passer: r["passer"],
      });

      if (drawn >= yardline) {
        reached++;
      }

      if (drawn >= 20) {
        long++;
      }

      if (drawn >= 40) {
        huge++;
      }
    }

    const scores = reached / TRIES;
    const band = bandOf(yardline);
    const its = byBand.get(band) ?? { plays: 0, said: 0, was: 0 };
    its.said += share * scores;
    byBand.set(band, its);
    tail.said += share;
    tail.saidLong += share * (long / TRIES);
    tail.saidHuge += share * (huge / TRIES);
    const own = mine(man);
    const got = man === r["player"] ? 1 : 0;
    own.walk += share * scores;
    own.hisTouches += got * scores;
    own.hisScoring += share * scored;
    own.was += got * scored;
    own.touches += got;
    own.nearTouches += yardline <= 10 ? got : 0;
    saidScores += share * scores;

    if (yardline > 20) {
      fromOut.walk += share * scores;
    }
  }
}

const busy = [...each.entries()].filter(([, t]) => t.touches >= 50);
const was = busy.map(([, t]) => t.was);
const order = (of: (t: Tally) => number) =>
  spearman(busy.map(([, t]) => of(t)), was).toFixed(3);

console.log(
  `${SEASON}: the walk makes ${saidScores.toFixed(0)} touchdowns on these ` +
  `plays where ${realScores} really happened.\n` +
  `  ${(100 * fromOut.walk / Math.max(1, saidScores)).toFixed(1)}% of its come ` +
  `from outside the twenty, against ` +
  `${(100 * fromOut.was / Math.max(1, realScores)).toFixed(1)}% of the real ones.`,
);
console.log(
  `  its gains go twenty or more ` +
  `${(100 * tail.saidLong / Math.max(1, tail.said)).toFixed(2)}% of the time ` +
  `against ${(100 * tail.wasLong / Math.max(1, tail.was)).toFixed(2)}%, ` +
  `and forty or more ` +
  `${(100 * tail.saidHuge / Math.max(1, tail.said)).toFixed(2)}% against ` +
  `${(100 * tail.wasHuge / Math.max(1, tail.was)).toFixed(2)}%`,
);
console.log("\nhow often a play from here scores at all:");

for (const band of ["the one", "inside the three", "inside the five",
  "inside the ten", "inside the twenty", "further out"]) {
  const its = byBand.get(band);

  if (its && its.plays > 50) {
    console.log(
      `  ${band.padEnd(19)}${String(its.plays).padStart(6)} plays  ` +
      `walk ${(100 * its.said / its.plays).toFixed(1)}%  ` +
      `really ${(100 * its.was / its.plays).toFixed(1)}%`,
    );
  }
}

console.log(
  `\nordering ${busy.length} men with 50 touches by the scores they made:\n` +
  `  the walk, both parts its own          ${order((t) => t.walk)}\n` +
  `  the truth about who got the ball      ${order((t) => t.hisTouches)}\n` +
  `  the truth about whether it scored     ${order((t) => t.hisScoring)}\n` +
  `  how often he touched it at all        ${order((t) => t.touches)}\n` +
  `  how often he touched it inside the 10 ${order((t) => t.nearTouches)}`,
);
