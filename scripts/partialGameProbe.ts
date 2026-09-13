/**
 * Asks how much a part played game says about the rest of it.
 *
 * The live draws pull the rest of a player's week toward his pace so far
 * with weight q, the fraction of the game clock gone. Fantasy points are
 * a sum of heavy tailed plays, so a part game says less than q suggests.
 *
 * This scores every play in PPR, cuts each player game at q in
 * {0.1 ... 0.5}, and regresses the points after the cut on the pace
 * before it. The slope over (1 - q) is the weight the data asks for,
 * split by whether one play was worth more than half the early points.
 *
 * Run: npx tsx scripts/partialGameProbe.ts [--seasons 2021,2022]
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitLine } from "../src/data/csv.js";
import {
  normalQuantile, quantileOf, spreadOf, weekAtNormal, pointsOf, type Spread,
} from "../app/lib/spread.ts";
import { paceWeight, RATE_SHARE } from "../app/lib/copula.ts";

const TOUCHES = join(
  import.meta.dirname, "..", "data", "curated", "touches.csv");

const CUTS = [0.1, 0.2, 0.3, 0.4, 0.5];

const GAME_SECONDS = 3600;

/** how far out a pace is read, the same clip the live draws use */
const FURTHEST = 0.002;

/** below this a player's own games are too few to read a quantile off */
const MIN_GAMES = 8;

/** the middle 80% of a predicted remainder, as normals */
const BAND = [normalQuantile(0.1), normalQuantile(0.9)] as const;

interface Play {
  seconds: number;
  points: number;
}

const seasonsAsked = (): number[] => {
  const at = process.argv.indexOf("--seasons");

  if (at < 0) {
    return [2021, 2022, 2023, 2024, 2025];
  }

  return (process.argv[at + 1] ?? "").split(",").map(Number);
};

const number = (text: string | undefined) => {
  const n = Number(text);

  return Number.isFinite(n) ? n : 0;
};

/**
 * Standard PPR off the columns this file has. A sack arrives as a pass
 * with nobody carrying the ball and negative yards, so the passer is
 * paid on completions only and sack yards go nowhere.
 */
function scorePlay(row: string[]): Array<[string, number]> {
  const kind = row[9]!;
  const player = row[10]!;
  const passer = row[11]!;
  const caught = row[13] === "1";
  const yards = number(row[14]);
  const touchdown = number(row[15]);

  if (kind === "run") {
    if (!player) {
      return [];
    }

    return [[player, 0.1 * yards + 6 * touchdown]];
  }

  if (!caught) {
    return [];
  }

  const out: Array<[string, number]> = [];

  if (passer) {
    out.push([passer, 0.04 * yards + 4 * touchdown]);
  }

  if (player) {
    out.push([player, 1 + 0.1 * yards + 6 * touchdown]);
  }

  return out;
}

/** every player game in the seasons asked for, as scored plays */
function readGames(seasons: Set<number>): Map<string, Play[]> {
  const lines = readFileSync(TOUCHES, "utf8").split("\n");
  const games = new Map<string, Play[]>();

  for (let at = 1; at < lines.length; at++) {
    const line = lines[at]!;

    if (!line) {
      continue;
    }

    const row = splitLine(line);
    const season = number(row[0]);

    if (!seasons.has(season)) {
      continue;
    }

    const seconds = number(row[8]);

    for (const [player, points] of scorePlay(row)) {
      const key = `${season}|${player}|${row[1]}`;
      const his = games.get(key);

      if (his) {
        his.push({ seconds, points });
      } else {
        games.set(key, [{ seconds, points }]);
      }
    }
  }

  return games;
}

const sum = (its: number[]) => its.reduce((total, n) => total + n, 0);
const mean = (its: number[]) => sum(its) / Math.max(1, its.length);

const sdOf = (its: number[]) => {
  const m = mean(its);

  return Math.sqrt(mean(its.map((n) => (n - m) ** 2)));
};

/** a player's season: the games he touched the ball in, and their shape */
interface Season {
  games: Array<{ plays: Play[]; points: number }>;
  mean: number;
  sd: number;
  spread: Spread;
}

function seasonsOf(games: Map<string, Play[]>): Map<string, Season> {
  const by = new Map<string, Season["games"]>();

  for (const [key, plays] of games) {
    const [season, player] = key.split("|");
    const at = `${season}|${player}`;
    const game = { plays, points: sum(plays.map((play) => play.points)) };

    by.set(at, [...(by.get(at) ?? []), game]);
  }

  const out = new Map<string, Season>();

  for (const [at, his] of by) {
    if (his.length < MIN_GAMES) {
      continue;
    }

    const points = his.map((game) => game.points);

    out.set(at, {
      games: his,
      mean: mean(points),
      sd: Math.max(0.5, sdOf(points)),
      spread: spreadOf(points),
    });
  }

  return out;
}

/** the pace before a cut, written as a normal the way the live draws do */
function paceNormal(spread: Spread, before: number, q: number): number {
  const at = quantileOf(spread, before / q);

  return normalQuantile(Math.min(1 - FURTHEST, Math.max(FURTHEST, at)));
}

interface Fit {
  n: number;
  sxx: number;
  sxy: number;
  syy: number;
}

const empty = (): Fit => ({ n: 0, sxx: 0, sxy: 0, syy: 0 });

const add = (fit: Fit, x: number, y: number) => {
  fit.n++;
  fit.sxx += x * x;
  fit.sxy += x * y;
  fit.syy += y * y;
};

/** how far the slope could be out, so a weight is not read off noise */
const errorOf = (fit: Fit) => {
  const slope = fit.sxx > 0 ? fit.sxy / fit.sxx : 0;
  const left = Math.max(0, fit.syy - slope * fit.sxy);

  return fit.sxx > 0 && fit.n > 2
    ? Math.sqrt(left / (fit.n - 2) / fit.sxx)
    : 0;
};

const corrOf = (fit: Fit) =>
  fit.sxx > 0 && fit.syy > 0 ? fit.sxy / Math.sqrt(fit.sxx * fit.syy) : 0;

/**
 * A slope with no intercept, which is what a weight is. Both sides are
 * centred inside a player season before they get here, so how good a
 * player is cannot stand in for how his afternoon started.
 */
const slopeOf = (fit: Fit) => (fit.sxx > 0 ? fit.sxy / fit.sxx : 0);

/** each game's pace normal and remainder, centred over a player's season */
function centred(his: Season, q: number) {
  const its = his.games.map((game) => {
    const early = game.plays.filter(
      (play) => play.seconds > GAME_SECONDS * (1 - q));
    const before = sum(early.map((play) => play.points));

    return {
      z: paceNormal(his.spread, before, q),
      raw: paceNormal(his.spread, before, q),
      y: (game.points - before) / his.sd,
      after: game.points - before,
      big: biggest(early.map((play) => play.points)) > 0.5,
    };
  });
  const mz = mean(its.map((it) => it.z));
  const my = mean(its.map((it) => it.y));

  return its.map((it) => ({ ...it, z: it.z - mz, y: it.y - my }));
}

interface Coverage {
  n: number;
  inside: number;
}

const covered = (
  spread: Spread, q: number, z: number, after: number,
  weight: number, width: number, cover: Coverage,
) => {
  const points = pointsOf(spread);
  const left = 1 - q;
  const low = left * weekAtNormal(points, weight * z + width * BAND[0]);
  const high = left * weekAtNormal(points, weight * z + width * BAND[1]);

  cover.n++;

  if (after >= low && after <= high) {
    cover.inside++;
  }
};

/** the weight a rate share r asks for at a fraction q played */
const fittedWeight = (q: number, r: number) => (q * r) / (q * r + (1 - r));

const biggest = (its: number[]) => {
  const total = sum(its);

  return total > 0 ? Math.max(...its) / total : 0;
};

interface Row {
  q: number;
  slope: number;
  weight: number;
  most: number;
  corr: number;
  big: number;
  small: number;
  n: number;
}

/** 95% of a normal is inside this many standard errors */
const TWO_SIDED = 1.96;

function run() {
  const seasons = new Set(seasonsAsked());
  const byPlayer = seasonsOf(readGames(seasons));
  const rows: Row[] = [];
  const coverage = new Map<string, Coverage>();
  const ask = (name: string) => {
    const had = coverage.get(name);

    if (had) {
      return had;
    }

    const fresh = { n: 0, inside: 0 };
    coverage.set(name, fresh);

    return fresh;
  };
  const seen: Array<{ q: number; spread: Spread; z: number; after: number }> =
    [];

  for (const q of CUTS) {
    const all = empty();
    const big = empty();
    const small = empty();

    for (const his of byPlayer.values()) {
      for (const game of centred(his, q)) {
        add(all, game.z, game.y);
        add(game.big ? big : small, game.z, game.y);
        seen.push({ q, spread: his.spread, z: game.raw, after: game.after });
        covered(
          his.spread, q, game.raw, game.after, q,
          Math.sqrt(Math.max(0, 1 - q * q)), ask(`app q=${q}`));
      }
    }

    rows.push({
      q,
      slope: slopeOf(all),
      weight: slopeOf(all) / (1 - q),
      most: (slopeOf(all) + TWO_SIDED * errorOf(all)) / (1 - q),
      corr: corrOf(all),
      big: slopeOf(big) / (1 - q),
      small: slopeOf(small) / (1 - q),
      n: all.n,
    });
  }

  // The fitted weights come out at or below zero, so a least squares r
  // would delete the pace. r is fitted to the top of the interval
  // instead, which keeps the pace as strong as the data allows.
  let best = { r: 0.005, loss: Infinity };

  for (let r = 0.005; r < 1; r += 0.005) {
    const loss = sum(rows.map(
      (row) => (fittedWeight(row.q, r) - Math.max(0, row.most)) ** 2));

    if (loss < best.loss) {
      best = { r, loss };
    }
  }

  for (const { q, spread, z, after } of seen) {
    const w = paceWeight(q);

    covered(
      spread, q, z, after, w,
      Math.sqrt(Math.max(0, 1 - w * w)), ask(`unit width q=${q}`));
    covered(
      spread, q, z, after, w,
      Math.sqrt(RATE_SHARE * (1 - w) + (1 - RATE_SHARE) / (1 - q)),
      ask(`shipped q=${q}`));
  }

  console.log(
    `player seasons with at least ${MIN_GAMES} games: ${byPlayer.size}`);
  console.log("");
  console.log(
    "  q      n   slope    corr  fitted w   most w   app w"
    + "  w big play  w without");

  for (const row of rows) {
    console.log([
      row.q.toFixed(1).padStart(3),
      String(row.n).padStart(7),
      row.slope.toFixed(3).padStart(8),
      row.corr.toFixed(3).padStart(8),
      row.weight.toFixed(3).padStart(10),
      row.most.toFixed(3).padStart(9),
      row.q.toFixed(3).padStart(8),
      row.big.toFixed(3).padStart(12),
      row.small.toFixed(3).padStart(11),
    ].join(""));
  }

  console.log("");
  console.log(
    `rate share r fitted at ${best.r.toFixed(3)},`
    + ` shipped at ${RATE_SHARE.toFixed(3)}`);
  console.log("  q   fitted w   formula w   shipped w");

  for (const row of rows) {
    console.log([
      row.q.toFixed(1).padStart(3),
      row.weight.toFixed(3).padStart(11),
      fittedWeight(row.q, best.r).toFixed(3).padStart(12),
      paceWeight(row.q).toFixed(3).padStart(12),
    ].join(""));
  }

  console.log("");
  console.log("middle 80% coverage of the remainder");

  for (const [name, cover] of coverage) {
    console.log(
      `${name.padEnd(20)} ${(cover.inside / Math.max(1, cover.n)).toFixed(3)}`
      + ` over ${cover.n}`);
  }
}

run();
