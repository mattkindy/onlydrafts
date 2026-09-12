/**
 * Who is right about the rest of a game that is already under way?
 *
 * Every game of a tested week is stopped at six snaps, and three ways of
 * pricing what each man still has to come are scored against what he
 * actually got from that snap on: his whole week line scaled by the
 * clock, the copula posterior the live pages draw, and the rest of the
 * game played out snap by snap. The two sides' remaining points are
 * scored on their own, so the engine can be caught being wrong at all,
 * and random paired lineups give a Brier score and a spread.
 *
 * Run: npx tsx scripts/liveRemainderEval.ts [seasons]
 * It wants the checkpoints scripts/aggregateCheckpoints.ts writes.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildWorld } from "../src/features/playedWorld.js";
import {
  linesFrom, playGame, type GameStart, type Side,
} from "../src/model/gameFromDrives.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { seededRng } from "../src/sim/rng.js";
import { acrossCores, myShare } from "../src/sim/acrossCores.js";
import { fromCache, type Checkpoint } from "../src/backtest/checkpoints.js";
import {
  addTally, emptyTally, lineupFrom, record, type Tally,
} from "../src/backtest/lineups.js";
import { linesFromCache, type LiveLine } from "../src/backtest/liveLines.js";
import { fractionLeft, liveDraws } from "../app/lib/matchups.ts";
import type { SlateRow } from "../app/lib/slate.ts";
import { mixFor, normalAt, PASS_CATCHERS } from "../app/lib/copula.ts";
import { normalCdf, weekAt } from "../app/lib/spread.ts";
import { winChance } from "../app/lib/winShare.ts";

const SEASONS = (process.env["SEASONS_ARG"] ?? process.argv[2] ?? "2024,2025")
  .split(",").map(Number);
const WEEKS = (process.env["WEEKS_ARG"] ?? "6,9,12,15").split(",").map(Number);
const RUNS = Number(process.env["RUNS"] ?? 150);
const LINEUPS = Number(process.env["LINEUPS"] ?? 120);
const SEATED = ["QB", "RB", "WR", "TE"];

const VARIANTS = ["time scaled", "copula posterior", "remainder sim"] as const;
type VariantName = (typeof VARIANTS)[number];

interface Cell {
  n: number;
  absErr: number;
  bias: number;
}

/** the sums a share sends home */
interface Pooled {
  /** by checkpoint, position and variant */
  men: Record<string, Cell>;
  /** by checkpoint, the two sides' remaining points */
  teams: Record<string, Cell>;
  tallies: Record<string, Tally>;
}

const empty = (): Pooled => ({ men: {}, teams: {}, tallies: {} });

function add(
  into: Record<string, Cell>, key: string, said: number, was: number,
): void {
  const cell = into[key] ?? { n: 0, absErr: 0, bias: 0 };
  into[key] = cell;
  cell.n++;
  cell.absErr += Math.abs(said - was);
  cell.bias += said - was;
}

function mergeCells(
  into: Record<string, Cell>, more: Record<string, Cell>,
): void {
  for (const [key, cell] of Object.entries(more)) {
    const mine = into[key] ?? { n: 0, absErr: 0, bias: 0 };
    into[key] = mine;
    mine.n += cell.n;
    mine.absErr += cell.absErr;
    mine.bias += cell.bias;
  }
}

function mergeInto(into: Pooled, more: Pooled): void {
  mergeCells(into.men, more.men);
  mergeCells(into.teams, more.teams);

  for (const [name, tally] of Object.entries(more.tallies)) {
    into.tallies[name] = into.tallies[name] ?? emptyTally();
    addTally(into.tallies[name]!, tally);
  }
}

const mean = (its: number[]) =>
  its.length ? its.reduce((s, n) => s + n, 0) / its.length : 0;

/**
 * The clock as a scoreboard shows it, so the shipped fraction left reads
 * a checkpoint the same way it reads a live game.
 */
function leftAt(secondsLeft: number): number {
  const quarter =
    Math.min(4, Math.max(1, Math.ceil((3600 - secondsLeft) / 900) || 1));
  const inQuarter = secondsLeft - (4 - quarter) * 900;
  const minutes = Math.floor(inQuarter / 60);
  const seconds = Math.floor(inQuarter % 60);

  return fractionLeft(quarter, `${minutes}:${String(seconds).padStart(2, "0")}`);
}

interface Man {
  key: string;
  playerId: string;
  position: string;
  team: string;
  opponent: string;
  /** his whole week, as the site would have priced it before kickoff */
  five: number[];
  blend: number;
  soFar: number;
  /** what the rest of the game actually gave him */
  was: number;
  said: Record<VariantName, number>;
  draws: Record<VariantName, number[]>;
}

const noNumbers = (): Record<VariantName, number> =>
  ({ "time scaled": 0, "copula posterior": 0, "remainder sim": 0 });
const noDraws = (): Record<VariantName, number[]> =>
  ({ "time scaled": [], "copula posterior": [], "remainder sim": [] });

/** a man's whole week drawn off his five figures, the copula in it */
function drawsOfWeek(man: Man, top: boolean): number[] {
  const mix = mixFor(
    { key: man.key, position: man.position, team: man.team },
    man.opponent, 0, PASS_CATCHERS.includes(man.position) ? top : null,
  );

  return Array.from({ length: RUNS }, (_, i) =>
    weekAt(man.five, normalCdf(normalAt(mix, i, RUNS))));
}

/** one checkpoint, priced every way */
function scoreOne(
  stop: Checkpoint,
  world: Awaited<ReturnType<typeof buildWorld>>,
  rows: Map<string, SlateRow>,
  lineFor: Map<string, Man>,
  out: Pooled,
): Man[] {
  const home = world.sideFor(stop.home) as Side | undefined;
  const away = world.sideFor(stop.away) as Side | undefined;
  const left = leftAt(stop.state.secondsLeft);

  if (!home || !away || left <= 0) {
    return [];
  }

  const truth = new Map(stop.men.map((man) => [man.playerId, man]));
  const onSide = [...lineFor.values()].filter(
    (man) => man.team === stop.home || man.team === stop.away);

  if (!onSide.length) {
    return [];
  }

  const simmed = new Map<string, number[]>();
  const teamLeft: Record<string, number[]> =
    { [stop.home]: [], [stop.away]: [] };
  const from: GameStart = stop.state;

  for (let run = 0; run < RUNS; run++) {
    const rng = seededRng(
      stop.gameId.length * 7919 + stop.label.length * 131 +
      stop.state.secondsLeft * 31 + run * 104729,
    );
    const game = playGame(home, away, {
      rules: { ...world.rules, kickSucceeds: world.kicking.kickSucceeds },
      fourth: world.fourth,
      clock: {
        isLast: world.kicking.isLast, lastLength: world.kicking.lastLength,
      },
      ticking: world.ticking, season: stop.season, week: stop.week,
    }, rng, {
      length: 3600, half: 1800, afterKickoff: 75, mostDrives: 40, from,
    });

    for (const team of [stop.home, stop.away]) {
      teamLeft[team]!.push(
        (game.points[team] ?? 0) - (stop.state.points[team] ?? 0));
    }

    for (const [playerId, line] of linesFrom(game, [home, away])) {
      const his = simmed.get(playerId) ?? (new Array(RUNS).fill(0) as number[]);
      simmed.set(playerId, his);
      his[run] = fantasyPoints(line, presets.ppr);
    }
  }

  for (const team of [stop.home, stop.away]) {
    add(
      out.teams, `${stop.label}|remainder sim`, mean(teamLeft[team]!),
      (stop.finalPoints[team] ?? 0) - (stop.state.points[team] ?? 0),
    );
  }

  const states = new Map([
    [stop.home, { where: "in" as const, left }],
    [stop.away, { where: "in" as const, left }],
  ]);
  const live = liveDraws(
    onSide.map((man) => ({
      key: man.key, slot: man.position,
      points: truth.get(man.playerId)?.soFar ?? 0,
    })),
    rows, states, RUNS,
  );
  const best = new Map<string, [string, number]>();

  for (const man of onSide) {
    const leader = best.get(man.team);

    if (PASS_CATCHERS.includes(man.position) &&
        (!leader || man.blend > leader[1]!)) {
      best.set(man.team, [man.key, man.blend]);
    }
  }

  return onSide.map((man) => {
    const his = truth.get(man.playerId);
    const draws: Record<VariantName, number[]> = {
      "time scaled": drawsOfWeek(man, best.get(man.team)?.[0] === man.key)
        .map((points) => points * left),
      "copula posterior": live.toCome(man.key),
      "remainder sim": simmed.get(man.playerId) ??
        (new Array(RUNS).fill(0) as number[]),
    };
    const one: Man = {
      ...man,
      soFar: his?.soFar ?? 0,
      was: his?.toCome ?? 0,
      draws,
      said: {
        "time scaled": man.blend * left,
        "copula posterior": mean(draws["copula posterior"]),
        "remainder sim": mean(draws["remainder sim"]),
      },
    };

    for (const variant of VARIANTS) {
      add(out.men, `${stop.label}|${man.position}|${variant}`,
          one.said[variant], one.was);
    }

    return one;
  });
}

function mulberry32(seed: number) {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** paired random lineups, a man's draws being what he has plus what is left */
function pairUp(
  label: string, pools: Map<string, Man[]>, out: Pooled, seed: number,
): void {
  if (!SEATED.every((position) => (pools.get(position) ?? []).length > 8)) {
    return;
  }

  const rand = mulberry32(seed);
  const totalOf = (side: Man[], variant: VariantName) => {
    const totals = new Array(RUNS).fill(0) as number[];

    for (const man of side) {
      for (let i = 0; i < RUNS; i++) {
        totals[i] = totals[i]! + man.soFar + (man.draws[variant][i] ?? 0);
      }
    }

    return totals;
  };
  const scoredBy = (side: Man[]) =>
    side.reduce((sum, man) => sum + man.soFar + man.was, 0);

  for (let pair = 0; pair < LINEUPS / 2; pair++) {
    const mine = lineupFrom(pools, rand);
    const theirs = lineupFrom(pools, rand);

    if (!mine || !theirs) {
      continue;
    }

    const shared = new Set(mine.map((man) => man.key));

    if (theirs.some((man) => shared.has(man.key))) {
      continue;
    }

    for (const variant of VARIANTS) {
      const key = `${label}|${variant}`;
      out.tallies[key] = out.tallies[key] ?? emptyTally();
      record(
        out.tallies[key]!, totalOf(mine, variant), totalOf(theirs, variant),
        scoredBy(mine), scoredBy(theirs), winChance,
      );
    }
  }
}

const ORDER = ["endQ1", "thirdQ2", "midQ2", "half", "redQ3", "endQ3"];

function report(pooled: Pooled): void {
  console.log("\nremaining points, MAE / bias by position");
  console.log("checkpoint  position  " +
    VARIANTS.map((v) => v.padEnd(16)).join(""));

  for (const label of ORDER) {
    for (const position of SEATED) {
      const some = pooled.men[`${label}|${position}|remainder sim`];

      if (!some?.n) {
        continue;
      }

      const cells = VARIANTS.map((variant) => {
        const cell = pooled.men[`${label}|${position}|${variant}`]!;

        return `${(cell.absErr / cell.n).toFixed(2)} / ${
          (cell.bias / cell.n).toFixed(2)}`.padEnd(16);
      });

      console.log(`${label.padEnd(11)} ${position.padEnd(9)} ` +
        `${cells.join("")}  n=${some.n}`);
    }
  }

  console.log("\nthe two sides' remaining points, the sim on its own");

  for (const label of ORDER) {
    const cell = pooled.teams[`${label}|remainder sim`];

    if (!cell?.n) {
      continue;
    }

    console.log(`${label.padEnd(11)} MAE ${(cell.absErr / cell.n).toFixed(2)}` +
      `  bias ${(cell.bias / cell.n).toFixed(2)}  n=${cell.n}`);
  }

  console.log("\nmatchups: brier, and implied against realised spread");

  for (const label of ORDER) {
    for (const variant of VARIANTS) {
      const tally = pooled.tallies[`${label}|${variant}`];

      if (!tally?.pairs) {
        continue;
      }

      const spread = (sum: number, over: number) => Math.sqrt(sum / over);

      console.log(`${label.padEnd(11)} ${variant.padEnd(18)}` +
        ` brier ${(tally.brier / tally.pairs).toFixed(4)}` +
        `  side ${spread(tally.impliedSide, tally.sides).toFixed(1)} vs ` +
        `${spread(tally.realizedSide, tally.sides).toFixed(1)}` +
        `  margin ${spread(tally.impliedDiff, tally.pairs).toFixed(1)} vs ` +
        `${spread(tally.realizedDiff, tally.pairs).toFixed(1)}` +
        `  n=${tally.pairs}`);
    }
  }
}

/** the week's men, in the two shapes the variants want them */
function menOfWeek(
  lines: LiveLine[],
): { rows: Map<string, SlateRow>; lineFor: Map<string, Man> } {
  const rows = new Map<string, SlateRow>();
  const lineFor = new Map<string, Man>();

  for (const line of lines) {
    const { playerId, position, team, opponent, blend, five } = line;

    rows.set(playerId, {
      playerId, name: playerId, position, team, opponent, home: true,
      ours: line.ours, sleeper: line.sleeper, blend,
      floor: five[0]!, q1: five[1]!, q3: five[3]!, ceiling: five[4]!,
      questionable: false, gamesMissedRecent: 0, absenceShare: 0,
    });
    lineFor.set(playerId, {
      key: playerId, playerId, position, team, opponent, five, blend,
      soFar: 0, was: 0, said: noNumbers(), draws: noDraws(),
    });
  }

  return { rows, lineFor };
}

async function main(): Promise<void> {
  const asShare = process.env["SHARE"] !== undefined;
  const jobs =
    SEASONS.flatMap((season) => WEEKS.map((week) => ({ season, week })));

  if (!asShare) {
    const printed = await acrossCores({
      script: import.meta.filename,
      /**
       * Each share fits a whole world of its own, so a machine short
       * of memory wants fewer shares than it has cores.
       */
      shares: Number(process.env["SHARES_WANTED"] ?? 0) || undefined,
      env: {
        RUNS: String(RUNS), LINEUPS: String(LINEUPS),
        SEASONS_ARG: SEASONS.join(","), WEEKS_ARG: WEEKS.join(","),
      },
    });
    const pooled = empty();

    for (const printing of printed) {
      const last = printing.trim().split("\n").at(-1) ?? "";

      if (!last.startsWith("{")) {
        continue;
      }

      mergeInto(pooled, JSON.parse(last) as Pooled);
    }

    report(pooled);
    return;
  }

  const out = empty();
  const mine = new Set(myShare(jobs.map((_, at) => at)));
  let at = -1;

  for (const season of SEASONS) {
    const curated = (name: string) =>
      join(import.meta.dirname, "..", "data", "curated", name);
    const path = curated(`checkpoints-${season}.csv`);
    const linesPath = curated(`liveLines-${season}.csv`);
    const anyOfMine = jobs.some((job, index) =>
      job.season === season && mine.has(index));

    if (!anyOfMine || !existsSync(path) || !existsSync(linesPath)) {
      at += WEEKS.length;
      continue;
    }

    const positions = new Map<string, string>();

    for (const s of await loadPlayerStats(season - 1)) {
      positions.set(s.playerId, s.position);
    }

    const lines = linesFromCache(await readFile(linesPath, "utf8"));
    const stops = fromCache(await readFile(path, "utf8"));

    for (const week of WEEKS) {
      at++;

      if (!mine.has(at)) {
        continue;
      }

      const thisWeek = stops.filter((one) => one.week === week);

      if (!thisWeek.length) {
        continue;
      }

      const world = await buildWorld(season, week, true, positions);
      console.error(`${season} week ${week}: ${thisWeek.length} checkpoints`);
      const { rows, lineFor } =
        menOfWeek(lines.filter((line) => line.week === week));
      const pools = new Map<string, Map<string, Man[]>>();

      for (const stop of thisWeek) {
        const byPosition = pools.get(stop.label) ?? new Map<string, Man[]>();
        pools.set(stop.label, byPosition);

        for (const man of scoreOne(stop, world, rows, lineFor, out)) {
          byPosition.set(
            man.position, [...(byPosition.get(man.position) ?? []), man]);
        }
      }

      for (const [label, byPosition] of pools) {
        pairUp(label, byPosition, out, season * 1000 + week * 17 + label.length);
      }
    }
  }

  console.log(JSON.stringify(out));
}

await main();
