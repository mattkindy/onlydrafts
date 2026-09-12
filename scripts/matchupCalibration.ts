/**
 * Are the live matchup odds too confident about the favourite?
 *
 * Projections and residual quantiles are built out of sample for 2024 and
 * 2025 the way the site builds them, random legal lineups are paired off,
 * each pair gets a win chance from the app's own draw path, and the
 * answer is checked against who actually scored more. Every variant is
 * reported the same way, so a change to the tails or to the quartiles can
 * be read against the shipped numbers.
 *
 * Run: npx tsx scripts/matchupCalibration.ts [--draws 800] [--lineups 160]
 */

import { loadGames } from "../src/data/nflverse.js";
import type { WeeklyExample } from "../src/features/weekly.js";
import { weeklyExamplesForSeason } from "../src/features/weeklyModel.js";
import {
  fitWeeklyByPosition,
  predictWeeklyByPosition,
} from "../src/features/fitWeeklyByPosition.js";
import {
  buildResidualModel,
  outcomeQuantile,
  type ResidualModel,
} from "../src/backtest/intervals.js";
import {
  loadSleeperWeekly,
  projectionKey,
} from "../src/data/sleeperProjections.js";
import {
  blendPoints,
  SHIPPED_BLEND_WEIGHT,
} from "../src/features/sleeperBlend.js";
import { mixFor, normalAt, PASS_CATCHERS } from "../app/lib/copula.ts";
import { normalCdf, weekAt } from "../app/lib/spread.ts";
import { winChance } from "../app/lib/winShare.ts";
import {
  BUCKETS, EDGES, emptyTally, lineupFrom, record, type Tally,
} from "../src/backtest/lineups.js";

const TRAIN = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023];
const TEST = [2024, 2025];

/** a man under this is nobody's starter, so lineups are drawn above it */
const LOW_BAR = 5;

/** which quantile each of the five figures is, as weekAt reads them */
const AT = [0.1, 0.25, 0.5, 0.75, 0.9];

const flag = (name: string, fallback: number) => {
  const at = process.argv.indexOf(`--${name}`);

  return at === -1 ? fallback : Number(process.argv[at + 1]);
};

const DRAWS = flag("draws", 800);
const LINEUPS = flag("lineups", 160);

function mulberry32(seed: number) {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The tail weekAt used to have, so a variant can be drawn the way the
 * site drew it before. Past the ninetieth it keeps going at the slope
 * the last segment had per unit of u.
 */
function linearAt(points: number[], u: number): number {
  if (u <= AT[0]!) {
    return points[0]! +
      (u - AT[0]!) * (points[1]! - points[0]!) / (AT[1]! - AT[0]!);
  }

  if (u >= AT[4]!) {
    return points[4]! +
      (u - AT[4]!) * (points[4]! - points[3]!) / (AT[4]! - AT[3]!);
  }

  return weekAt(points, u);
}

interface Man {
  key: string;
  position: string;
  team: string;
  opponent: string;
  top: boolean;
  ours: number;
  sleeper: number;
  blend: number;
  floor: number;
  ceiling: number;
  q1: number;
  q3: number;
  actual: number;
}

interface Variant {
  name: string;
  /** quartiles off the residual model, or halfway as the site does */
  quartiles: "midpoint" | "measured";
  tail: "linear" | "normal";
  /** how much the spread around his middle is widened */
  inflate: number;
  copula: boolean;
  /** whose projection is the middle of his week */
  centre?: Centre;
}

type Centre = "blend" | "ours" | "sleeper" | "byPosition";

/** the Sleeper weight the position tables in the backtest asked for */
const BY_POSITION: Record<string, number> = { QB: 0.25, RB: 0.75, WR: 0.5, TE: 0.5 };

function centreOf(man: Man, centre: Centre = "blend"): number {
  const at: Record<Centre, () => number> = {
    blend: () => man.blend,
    ours: () => man.ours,
    sleeper: () => man.sleeper,
    byPosition: () =>
      blendPoints(man.ours, man.sleeper, BY_POSITION[man.position] ?? 0.5),
  };

  return at[centre]();
}

const VARIANTS: Variant[] = [
  { name: "shipped", quartiles: "midpoint", tail: "linear", inflate: 1, copula: true },
  { name: "shipped, no copula", quartiles: "midpoint", tail: "linear", inflate: 1, copula: false },
  { name: "A normal tails", quartiles: "midpoint", tail: "normal", inflate: 1, copula: true },
  { name: "B measured quartiles", quartiles: "measured", tail: "linear", inflate: 1, copula: true },
  { name: "A+B", quartiles: "measured", tail: "normal", inflate: 1, copula: true },
  { name: "A+B, no copula", quartiles: "measured", tail: "normal", inflate: 1, copula: false },
  { name: "A+B+C 1.10", quartiles: "measured", tail: "normal", inflate: 1.1, copula: true },
  { name: "A+B+C 1.25", quartiles: "measured", tail: "normal", inflate: 1.25, copula: true },
  { name: "A+B, ours alone", quartiles: "measured", tail: "normal", inflate: 1, copula: true, centre: "ours" },
  { name: "A+B, Sleeper alone", quartiles: "measured", tail: "normal", inflate: 1, copula: true, centre: "sleeper" },
  { name: "A+B, blend by position", quartiles: "measured", tail: "normal", inflate: 1, copula: true, centre: "byPosition" },
];

function pointsFor(man: Man, variant: Variant): number[] {
  const q1 = variant.quartiles === "measured"
    ? man.q1
    : (man.floor + man.blend) / 2;
  const q3 = variant.quartiles === "measured"
    ? man.q3
    : (man.blend + man.ceiling) / 2;
  const shift = centreOf(man, variant.centre) - man.blend;
  const five = [man.floor, q1, man.blend, q3, man.ceiling]
    .map((p) => p + shift);

  if (variant.inflate === 1) {
    return five;
  }

  const middle = man.blend + shift;

  return five.map((p) => middle + variant.inflate * (p - middle));
}

/**
 * The numbers that pick a man's week, which is where the copula lives.
 * A man yet to kick off draws off the prior factors, so this is what
 * liveDraws hands weeksFromSpread before anybody has played.
 */
function uniformsFor(man: Man, copula: boolean): number[] {
  const mix = copula
    ? mixFor(
      { key: man.key, position: man.position, team: man.team },
      man.opponent,
      0,
      PASS_CATCHERS.includes(man.position) ? man.top : null,
    )
    : mixFor(
      { key: man.key, position: man.position, team: null }, null, 0, null);

  return Array.from(
    { length: DRAWS }, (_, i) => normalCdf(normalAt(mix, i, DRAWS)));
}

function weeksFor(man: Man, variant: Variant, uniforms: number[]): number[] {
  const points = pointsFor(man, variant);
  const at = variant.tail === "normal" ? weekAt : linearAt;

  return uniforms.map((u) => at(points, u));
}

const mean = (its: number[]) => its.reduce((s, n) => s + n, 0) / its.length;

function menOfWeek(
  examples: WeeklyExample[],
  weekly: ReturnType<typeof fitWeeklyByPosition>,
  residuals: ResidualModel,
  projections: Awaited<ReturnType<typeof loadSleeperWeekly>>,
  season: number,
  week: number,
): Man[] {
  const men: Man[] = [];
  const best = new Map<string, [string, number]>();

  for (const e of examples) {
    const ours = predictWeeklyByPosition(weekly, e);
    const sleeper = projections.get(
      projectionKey(season, week, e.playerId))?.points;
    if (sleeper === undefined) {
      continue;
    }

    const blend = blendPoints(ours, sleeper, SHIPPED_BLEND_WEIGHT);

    if (blend < LOW_BAR || !e.teamId || !e.opponent) {
      continue;
    }

    const quantile = (p: number) =>
      outcomeQuantile(residuals, e.position, blend, p);

    men.push({
      key: `${e.playerId}|${season}|${week}`,
      position: e.position,
      team: e.teamId.toUpperCase(),
      opponent: e.opponent.toUpperCase(),
      top: false,
      ours,
      sleeper,
      blend,
      floor: quantile(0.1),
      q1: quantile(0.25),
      q3: quantile(0.75),
      ceiling: quantile(0.9),
      actual: e.target,
    });

    if (PASS_CATCHERS.includes(e.position)) {
      const leader = best.get(e.teamId);

      if (!leader || blend > leader[1]!) {
        best.set(e.teamId, [men[men.length - 1]!.key, blend]);
      }
    }
  }

  const tops = new Set([...best.values()].map(([key]) => key));

  for (const man of men) {
    man.top = tops.has(man.key);
  }

  return men;
}

function show(name: string, tally: Tally): void {
  const rate = (won: number, count: number) =>
    count ? `${((won / count) * 100).toFixed(1)}%` : "-";

  console.log(`\n${name}  (${tally.pairs} pairs)`);
  console.log("  predicted    n     said   actually won");

  for (let at = 0; at < BUCKETS; at++) {
    const bucket = tally.buckets[at]!;

    if (!bucket.count) {
      continue;
    }

    const band = `${50 + at * 5}-${55 + at * 5}`;
    console.log(
      `  ${band.padEnd(9)} ${String(bucket.count).padStart(5)}  ` +
      `${((bucket.predicted / bucket.count) * 100).toFixed(1).padStart(6)}%  ` +
      `${rate(bucket.won, bucket.count).padStart(8)}`);
  }

  const sideSd = Math.sqrt(tally.impliedSide / tally.sides);
  const sideReal = Math.sqrt(tally.realizedSide / tally.sides);
  const diffSd = Math.sqrt(tally.impliedDiff / tally.pairs);
  const diffReal = Math.sqrt(tally.realizedDiff / tally.pairs);

  console.log(
    `  brier ${(tally.brier / tally.pairs).toFixed(4)}  ` +
    `log loss ${(tally.logLoss / tally.pairs).toFixed(4)}`);
  console.log(
    `  side sd: drawn ${sideSd.toFixed(1)}  realized ${sideReal.toFixed(1)}  ` +
    `(x${(sideReal / sideSd).toFixed(2)})  ` +
    `total mae ${(tally.sideError / tally.sides).toFixed(2)}`);
  console.log(
    `  margin sd: drawn ${diffSd.toFixed(1)}  realized ${diffReal.toFixed(1)}  ` +
    `(x${(diffReal / diffSd).toFixed(2)})`);
  console.log("  projected edge   n     said   actually won");

  for (let at = 0; at < EDGES.length; at++) {
    const edge = tally.edges[at]!;

    if (!edge.count) {
      continue;
    }

    const band = at === EDGES.length - 1
      ? `${EDGES[at]}+`
      : `${EDGES[at]}-${EDGES[at + 1]}`;
    console.log(
      `  ${band.padEnd(14)} ${String(edge.count).padStart(5)}  ` +
      `${((edge.predicted / edge.count) * 100).toFixed(1).padStart(6)}%  ` +
      `${rate(edge.won, edge.count).padStart(8)}`);
  }
}

/**
 * How wide the eighty is at each projection, which says whether the
 * residual model conditions on the level at all.
 */
function showBands(residuals: ResidualModel): void {
  console.log("eighty per cent band by projection:");

  for (const position of ["QB", "RB", "WR", "TE"]) {
    const widths = [4, 8, 12, 16, 22].map((points) => {
      const low = outcomeQuantile(residuals, position, points, 0.1);
      const high = outcomeQuantile(residuals, position, points, 0.9);

      return `${points}: ${(high - low).toFixed(1)}`;
    });

    console.log(`  ${position}  ${widths.join("   ")}`);
  }
}

async function main(): Promise<void> {
  const games = await loadGames();
  const train: WeeklyExample[] = [];

  for (const season of TRAIN) {
    train.push(...(await weeklyExamplesForSeason(season, games)));
  }

  const weekly = fitWeeklyByPosition(train);
  const residuals = buildResidualModel(
    train.map((e) => ({
      position: e.position,
      predicted: predictWeeklyByPosition(weekly, e),
      actual: e.target,
    })),
    5,
  );
  showBands(residuals);

  const projections = await loadSleeperWeekly();
  const tallies = new Map(VARIANTS.map((v) => [v.name, emptyTally()]));
  const rand = mulberry32(20240901);

  for (const season of TEST) {
    const examples = await weeklyExamplesForSeason(season, games);
    const byWeek = new Map<number, WeeklyExample[]>();

    for (const e of examples) {
      byWeek.set(e.week, [...(byWeek.get(e.week) ?? []), e]);
    }

    for (const [week, rows] of [...byWeek].sort((a, b) => a[0] - b[0])) {
      const men = menOfWeek(rows, weekly, residuals, projections, season, week);
      const pools = new Map<string, Man[]>();

      for (const man of men) {
        pools.set(man.position, [...(pools.get(man.position) ?? []), man]);
      }

      const enough = ["QB", "RB", "WR", "TE"]
        .every((p) => (pools.get(p) ?? []).length > 8);

      if (!enough) {
        continue;
      }

      const uniforms = new Map<string, number[]>();
      const weeks = new Map<string, number[]>();

      const drawsFor = (man: Man, variant: Variant): number[] => {
        const key = `${man.key}|${variant.name}`;
        let its = weeks.get(key);

        if (!its) {
          const seed = `${man.key}|${variant.copula}`;
          let us = uniforms.get(seed);

          if (!us) {
            us = uniformsFor(man, variant.copula);
            uniforms.set(seed, us);
          }

          its = weeksFor(man, variant, us);
          weeks.set(key, its);
        }

        return its;
      };

      const total = (side: Man[], variant: Variant) => {
        const out = new Array(DRAWS).fill(0) as number[];

        for (const man of side) {
          const his = drawsFor(man, variant);

          for (let i = 0; i < DRAWS; i++) {
            out[i] = out[i]! + his[i]!;
          }
        }

        return out;
      };

      for (let pair = 0; pair < LINEUPS / 2; pair++) {
        const mine = lineupFrom(pools, rand);
        const theirs = lineupFrom(pools, rand);

        if (!mine || !theirs) {
          continue;
        }

        const shared = new Set(mine.map((m) => m.key));

        if (theirs.some((m) => shared.has(m.key))) {
          continue;
        }

        const myActual = mine.reduce((s, m) => s + m.actual, 0);
        const theirActual = theirs.reduce((s, m) => s + m.actual, 0);

        for (const variant of VARIANTS) {
          record(
            tallies.get(variant.name)!,
            total(mine, variant),
            total(theirs, variant),
            myActual,
            theirActual,
            winChance,
          );
        }
      }
    }
  }

  console.log(
    `seasons ${TEST.join(", ")}, ${DRAWS} draws, ${LINEUPS} lineups a week`);

  for (const variant of VARIANTS) {
    show(variant.name, tallies.get(variant.name)!);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
