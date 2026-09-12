/**
 * How far off is a weekly projection, and how much of that is left to win?
 *
 * Every candidate says how many points a man scores in one week, and all
 * of them are scored the same way over 2024 and 2025, weeks 1 to 17, by
 * position and split at week 4. Sleeper's line is the rival. Two oracles
 * say where the room to improve is: one gets his actual targets, carries
 * and pass attempts and has to guess his rates, the other gets his rates
 * and has to guess the usage. See scripts/README.md for the rest.
 *
 * Scoring is full PPR, because Sleeper's points column is PPR.
 *
 * Run: npx tsx scripts/boxScoreWeekEval.ts
 */

import { loadGames, loadPlayerStats } from "../src/data/nflverse.js";
import type { GameRow, PlayerWeekStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
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
import {
  loadWalkWeekly,
  walkKey,
} from "../src/features/walkWeeklyCache.js";
import { normalCdf } from "../app/lib/spread.ts";

const RULES = presets.ppr;
const TRAIN = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023];
const TEST = [2024, 2025];
const POSITIONS = ["QB", "RB", "WR", "TE"];
const LAST_WEEK = 17;
const EARLY_THROUGH = 4;
const WINDOW = 4;
const DEFAULT_IMPLIED = 21.5;

/** a man under this is nobody's starter, so lineups are drawn above it */
const LOW_BAR = 5;
const LINEUPS = 120;

/** what a man did in one week, on both sides of usage times rate */
interface Box {
  passAtt: number;
  carries: number;
  targets: number;
  passYds: number;
  passTd: number;
  interceptions: number;
  rushYds: number;
  rushTd: number;
  receptions: number;
  recYds: number;
  recTd: number;
  points: number;
}

interface Usage {
  passAtt: number;
  carries: number;
  targets: number;
}

/** per-opportunity rates, which is what shrinks toward a position prior */
interface Rates {
  ypa: number;
  passTdRate: number;
  intRate: number;
  ypc: number;
  rushTdRate: number;
  ypt: number;
  catchRate: number;
  recTdRate: number;
}

function boxOf(s: PlayerWeekStats): Box {
  const line = s.statLine;

  return {
    passAtt: s.passing.attempts,
    carries: s.carries,
    targets: s.targets,
    passYds: line.passYds,
    passTd: line.passTd,
    interceptions: line.interceptions,
    rushYds: line.rushYds,
    rushTd: line.rushTd,
    receptions: line.receptions,
    recYds: line.recYds,
    recTd: line.recTd,
    points: fantasyPoints(line, RULES),
  };
}

const emptyBox = (): Box => ({
  passAtt: 0, carries: 0, targets: 0, passYds: 0, passTd: 0,
  interceptions: 0, rushYds: 0, rushTd: 0, receptions: 0, recYds: 0,
  recTd: 0, points: 0,
});

function addBox(into: Box, from: Box): void {
  for (const key of Object.keys(into) as (keyof Box)[]) {
    into[key] += from[key];
  }
}

const usageOf = (box: Box): Usage => ({
  passAtt: box.passAtt, carries: box.carries, targets: box.targets,
});

function scaleUsage(usage: Usage, by: number): Usage {
  return {
    passAtt: usage.passAtt * by,
    carries: usage.carries * by,
    targets: usage.targets * by,
  };
}

function mixUsage(a: Usage, b: Usage, weight: number): Usage {
  return {
    passAtt: (1 - weight) * a.passAtt + weight * b.passAtt,
    carries: (1 - weight) * a.carries + weight * b.carries,
    targets: (1 - weight) * a.targets + weight * b.targets,
  };
}

/**
 * Points from a man's opportunities and his rates, under the league's
 * rules. This is the whole component model in one place, so a candidate
 * differs only in where its usage and its rates come from.
 */
function pointsFrom(usage: Usage, rates: Rates): number {
  const passing = usage.passAtt *
    (RULES.passYds * rates.ypa + RULES.passTd * rates.passTdRate +
      RULES.interceptions * rates.intRate);
  const rushing = usage.carries *
    (RULES.rushYds * rates.ypc + RULES.rushTd * rates.rushTdRate);
  const receiving = usage.targets *
    (RULES.recYds * rates.ypt + RULES.receptions * rates.catchRate +
      RULES.recTd * rates.recTdRate);

  return passing + rushing + receiving;
}

/** how many opportunities a rate needs before it stops being the prior */
const SHRINK = { passAtt: 80, carries: 40, targets: 30 };

function ratesFrom(box: Box, prior: Rates, shrink = SHRINK): Rates {
  const per = (total: number, count: number, k: number, floor: number) =>
    (total + k * floor) / (count + k);

  return {
    ypa: per(box.passYds, box.passAtt, shrink.passAtt, prior.ypa),
    passTdRate: per(box.passTd, box.passAtt, shrink.passAtt, prior.passTdRate),
    intRate: per(box.interceptions, box.passAtt, shrink.passAtt, prior.intRate),
    ypc: per(box.rushYds, box.carries, shrink.carries, prior.ypc),
    rushTdRate: per(box.rushTd, box.carries, shrink.carries, prior.rushTdRate),
    ypt: per(box.recYds, box.targets, shrink.targets, prior.ypt),
    catchRate: per(box.receptions, box.targets, shrink.targets, prior.catchRate),
    recTdRate: per(box.recTd, box.targets, shrink.targets, prior.recTdRate),
  };
}

/** the same rates with no shrinkage, which is what one week itself says */
function rawRates(box: Box, prior: Rates): Rates {
  const per = (total: number, count: number, floor: number) =>
    count > 0 ? total / count : floor;

  return {
    ypa: per(box.passYds, box.passAtt, prior.ypa),
    passTdRate: per(box.passTd, box.passAtt, prior.passTdRate),
    intRate: per(box.interceptions, box.passAtt, prior.intRate),
    ypc: per(box.rushYds, box.carries, prior.ypc),
    rushTdRate: per(box.rushTd, box.carries, prior.rushTdRate),
    ypt: per(box.recYds, box.targets, prior.ypt),
    catchRate: per(box.receptions, box.targets, prior.catchRate),
    recTdRate: per(box.recTd, box.targets, prior.recTdRate),
  };
}

/**
 * League-average rates for each position over the training seasons, so a
 * man with three carries behind him is read as an average back rather
 * than as whatever those three carries did.
 */
async function positionPriors(): Promise<Map<string, Rates>> {
  const totals = new Map<string, Box>();

  for (const season of TRAIN) {
    for (const s of await loadPlayerStats(season)) {
      if (!POSITIONS.includes(s.position)) {
        continue;
      }

      const into = totals.get(s.position) ?? emptyBox();
      addBox(into, boxOf(s));
      totals.set(s.position, into);
    }
  }

  const priors = new Map<string, Rates>();

  for (const [position, box] of totals) {
    const per = (total: number, count: number) => (count > 0 ? total / count : 0);
    priors.set(position, {
      ypa: per(box.passYds, box.passAtt),
      passTdRate: per(box.passTd, box.passAtt),
      intRate: per(box.interceptions, box.passAtt),
      ypc: per(box.rushYds, box.carries),
      rushTdRate: per(box.rushTd, box.carries),
      ypt: per(box.recYds, box.targets),
      catchRate: per(box.receptions, box.targets),
      recTdRate: per(box.recTd, box.targets),
    });
  }

  return priors;
}

/** the implied points and the opponent for every team-week with a line */
interface TeamWeek {
  impliedTotal: number;
  opponent: string;
}

function teamWeeks(games: GameRow[]): Map<string, TeamWeek> {
  const out = new Map<string, TeamWeek>();

  for (const game of games) {
    const half = game.totalLine === undefined
      ? DEFAULT_IMPLIED
      : game.totalLine / 2;
    const edge = game.spreadLine === undefined ? 0 : game.spreadLine / 2;

    out.set(`${game.season}|${game.week}|${game.homeTeamId}`, {
      impliedTotal: half + edge, opponent: game.awayTeamId,
    });
    out.set(`${game.season}|${game.week}|${game.awayTeamId}`, {
      impliedTotal: half - edge, opponent: game.homeTeamId,
    });
  }

  return out;
}

/** one player-week, with everything a candidate is allowed to look at */
interface Row {
  playerId: string;
  position: string;
  season: number;
  week: number;
  teamId: string;
  actual: Box;
  /** his last four games played this season, summed */
  trailing: Box;
  trailingGames: number;
  /** his whole previous season, summed, and the games it took */
  prev: Box;
  prevGames: number;
  impliedTotal: number;
  sleeper: number | undefined;
  ridge: number | undefined;
  /** the game simulator's touches and points, for the weeks it has played */
  walkTouches: number | undefined;
  walkPoints: number | undefined;
}

async function rowsFor(
  season: number,
  games: Map<string, TeamWeek>,
  sleeper: Map<string, { points: number }>,
  ridge: Map<string, number>,
  walk: Map<string, { touches: number; points: number }>,
): Promise<Row[]> {
  const stats = await loadPlayerStats(season);
  const prevStats = await loadPlayerStats(season - 1);
  const prev = new Map<string, { box: Box; games: number }>();

  for (const s of prevStats) {
    const his = prev.get(s.playerId) ?? { box: emptyBox(), games: 0 };
    addBox(his.box, boxOf(s));
    his.games++;
    prev.set(s.playerId, his);
  }

  const byPlayer = new Map<string, PlayerWeekStats[]>();

  for (const s of stats) {
    if (!POSITIONS.includes(s.position) || s.week > LAST_WEEK) {
      continue;
    }

    byPlayer.set(s.playerId, [...(byPlayer.get(s.playerId) ?? []), s]);
  }

  const rows: Row[] = [];

  for (const [playerId, his] of byPlayer) {
    const sorted = [...his].sort((a, b) => a.week - b.week);

    sorted.forEach((s, at) => {
      const window = sorted.slice(Math.max(0, at - WINDOW), at);
      const trailing = emptyBox();

      for (const earlier of window) {
        addBox(trailing, boxOf(earlier));
      }

      const team = games.get(`${season}|${s.week}|${s.teamId}`);
      const before = prev.get(playerId);
      const walked = walk.get(walkKey(season, s.week, playerId));

      rows.push({
        playerId,
        position: s.position,
        season,
        week: s.week,
        teamId: s.teamId,
        actual: boxOf(s),
        trailing,
        trailingGames: window.length,
        prev: before?.box ?? emptyBox(),
        prevGames: before?.games ?? 0,
        impliedTotal: team?.impliedTotal ?? DEFAULT_IMPLIED,
        sleeper: sleeper.get(projectionKey(season, s.week, playerId))?.points,
        ridge: ridge.get(`${season}|${s.week}|${playerId}`),
        walkTouches: walked?.touches,
        walkPoints: walked?.points,
      });
    });
  }

  return rows;
}

/** per game over whichever window a candidate is reading */
function perGame(box: Box, count: number): Box {
  if (count <= 0) {
    return emptyBox();
  }

  const out = emptyBox();

  for (const key of Object.keys(out) as (keyof Box)[]) {
    out[key] = box[key] / count;
  }

  return out;
}

/** what a row's own history says his rates are, prior season included */
function historyRates(row: Row, prior: Rates): Rates {
  const box = emptyBox();
  addBox(box, row.trailing);
  addBox(box, row.prev);

  return ratesFrom(box, prior);
}

/** the per-game usage a candidate leans on when it has no better idea */
function baseUsage(row: Row): Usage {
  const recent = usageOf(perGame(row.trailing, row.trailingGames));
  const before = usageOf(perGame(row.prev, row.prevGames));

  if (row.trailingGames >= 3 || row.prevGames === 0) {
    return recent;
  }

  return mixUsage(before, recent, row.trailingGames / 3);
}

function trailingPoints(row: Row): number {
  if (row.trailingGames > 0) {
    return row.trailing.points / row.trailingGames;
  }

  if (row.prevGames > 0) {
    return row.prev.points / row.prevGames;
  }

  return 0;
}

/**
 * Our shipped line, as far as this harness can reproduce it: the ridge
 * model where it has an example, the previous season's points per game
 * before week 5, and his trailing form for a man with neither.
 */
function ourLine(row: Row): number {
  if (row.ridge !== undefined) {
    return row.ridge;
  }

  if (row.prevGames >= 4) {
    return row.prev.points / row.prevGames;
  }

  return trailingPoints(row);
}

interface Candidate {
  name: string;
  /** the points he is projected for, or undefined to skip the row */
  of: (row: Row, prior: Rates) => number | undefined;
  /** the usage that projection implies, where a candidate has one */
  usage?: (row: Row, prior: Rates) => Usage;
}

/** how much more a man is used when his side is projected to score more */
const IMPLIED_PULL = 0.35;

function impliedLift(row: Row): number {
  return 1 + IMPLIED_PULL * (row.impliedTotal / DEFAULT_IMPLIED - 1);
}

/**
 * The usage the component model works from. Vegas is off by default:
 * scaling a man's touches by his side's implied total costs a tenth of a
 * point at every position, so his own recent workload is left as it is.
 */
const componentUsage = (row: Row): Usage => baseUsage(row);

const liftedUsage = (row: Row): Usage =>
  scaleUsage(baseUsage(row), impliedLift(row));

/**
 * The same usage with its total touches set to what the game simulator
 * dealt him. The walk says how busy he is, not how his work splits
 * between the ground and the air, so the split stays his trailing one.
 * A quarterback's pass attempts are left alone, since touches do not
 * cover them.
 */
function walkUsage(row: Row, weight: number): Usage {
  const base = baseUsage(row);
  const touches = base.carries + base.targets;

  if (row.walkTouches === undefined || touches <= 0) {
    return base;
  }

  const wanted = (1 - weight) * touches + weight * row.walkTouches;

  return {
    passAtt: base.passAtt,
    carries: base.carries * (wanted / touches),
    targets: base.targets * (wanted / touches),
  };
}

const CANDIDATES: Candidate[] = [
  { name: "ours (shipped ridge)", of: ourLine },
  { name: "sleeper", of: (row) => row.sleeper },
  {
    name: "blend 0.5",
    of: (row) =>
      row.sleeper === undefined
        ? undefined
        : blendPoints(ourLine(row), row.sleeper, SHIPPED_BLEND_WEIGHT),
  },
  { name: "naive trailing 4", of: trailingPoints },
  {
    name: "(a) component",
    of: (row, prior) =>
      pointsFrom(componentUsage(row), historyRates(row, prior)),
    usage: componentUsage,
  },
  {
    name: "(a) component, vegas lift",
    of: (row, prior) => pointsFrom(liftedUsage(row), historyRates(row, prior)),
    usage: liftedUsage,
  },
  {
    name: "(a) component, blend 0.5",
    of: (row, prior) =>
      row.sleeper === undefined
        ? undefined
        : blendPoints(
          pointsFrom(componentUsage(row), historyRates(row, prior)),
          row.sleeper,
          SHIPPED_BLEND_WEIGHT,
        ),
  },
  {
    name: "(b) walk usage",
    of: (row, prior) =>
      row.walkTouches === undefined
        ? undefined
        : pointsFrom(walkUsage(row, 1), historyRates(row, prior)),
    usage: (row) => walkUsage(row, 1),
  },
  {
    name: "(b) walk usage, half",
    of: (row, prior) =>
      row.walkTouches === undefined
        ? undefined
        : pointsFrom(walkUsage(row, 0.5), historyRates(row, prior)),
    usage: (row) => walkUsage(row, 0.5),
  },
  { name: "(b) walk points", of: (row) => row.walkPoints },
  {
    name: "(c) early from prior season",
    of: (row, prior) => {
      if (row.week > EARLY_THROUGH) {
        return ourLine(row);
      }

      if (row.prevGames < 4) {
        return trailingPoints(row);
      }

      return pointsFrom(
        scaleUsage(usageOf(perGame(row.prev, row.prevGames)), impliedLift(row)),
        ratesFrom(row.prev, prior),
      );
    },
  },
  {
    name: "oracle: usage known",
    of: (row, prior) =>
      pointsFrom(usageOf(row.actual), historyRates(row, prior)),
    usage: (row) => usageOf(row.actual),
  },
  {
    name: "oracle: rates known",
    of: (row, prior) =>
      pointsFrom(componentUsage(row), rawRates(row.actual, prior)),
  },
  { name: "oracle: both known", of: (row) => row.actual.points },
];

interface Cell {
  n: number;
  absError: number;
  bias: number;
  targetsAbs: number;
  carriesAbs: number;
  usageRows: number;
}

const emptyCell = (): Cell => ({
  n: 0, absError: 0, bias: 0, targetsAbs: 0, carriesAbs: 0, usageRows: 0,
});

const groupOf = (week: number) => (week <= EARLY_THROUGH ? "1-4" : "5-17");
const GROUPS = ["1-4", "5-17"];

const mae = (cell: Cell) => (cell.n ? (cell.absError / cell.n).toFixed(2) : "-");

function bias(cell: Cell): string {
  if (!cell.n) {
    return "-";
  }

  const value = cell.bias / cell.n;

  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function showPoints(title: string, tallies: Map<string, Cell>): void {
  console.log(`\n${title}, mae/bias (projected minus actual)`);
  const header = GROUPS.flatMap((g) => POSITIONS.map((p) => `${p} wk${g}`));
  console.log(
    `  ${"candidate".padEnd(28)}${header.map((h) => h.padStart(15)).join("")}`);

  for (const candidate of CANDIDATES) {
    const cells = header.map((_, i) => {
      const group = GROUPS[Math.floor(i / POSITIONS.length)]!;
      const position = POSITIONS[i % POSITIONS.length]!;

      return tallies.get(`${candidate.name}|${position}|${group}`) ?? emptyCell();
    });
    console.log(
      `  ${candidate.name.padEnd(28)}` +
      cells.map((c) => `${mae(c)}/${bias(c)}`.padStart(15)).join(""));
  }
}

function showUsage(tallies: Map<string, Cell>): void {
  console.log("\ntargets and carries per man per week, mae, all weeks");
  console.log(
    `  ${"candidate".padEnd(28)}` +
    POSITIONS.map((p) => `${p} tgt/car`.padStart(16)).join(""));

  for (const candidate of CANDIDATES) {
    if (!candidate.usage) {
      continue;
    }

    const cells = POSITIONS.map((position) => {
      const out = emptyCell();

      for (const group of GROUPS) {
        const cell = tallies.get(`${candidate.name}|${position}|${group}`);

        if (cell) {
          out.usageRows += cell.usageRows;
          out.targetsAbs += cell.targetsAbs;
          out.carriesAbs += cell.carriesAbs;
        }
      }

      const per = (total: number) =>
        out.usageRows ? (total / out.usageRows).toFixed(2) : "-";

      return `${per(out.targetsAbs)}/${per(out.carriesAbs)}`;
    });
    console.log(
      `  ${candidate.name.padEnd(28)}${cells.map((c) => c.padStart(16)).join("")}`);
  }
}

/**
 * How wide the eighty per cent band is at each projection, under each
 * number of residual buckets. A band that barely widens from 8 points to
 * 22 is the complaint candidate (d) is about.
 */
function showBands(residuals: Map<number, ResidualModel>): void {
  console.log("\neighty per cent band by projection, by residual buckets");

  for (const [buckets, model] of residuals) {
    for (const position of POSITIONS) {
      const widths = [4, 8, 12, 16, 22, 28].map((points) => {
        const low = outcomeQuantile(model, position, points, 0.1);
        const high = outcomeQuantile(model, position, points, 0.9);

        return `${points}: ${(high - low).toFixed(1)}`;
      });
      console.log(`  ${String(buckets).padStart(2)} ${position}  ${widths.join("  ")}`);
    }
  }
}

function mulberry32(seed: number) {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEATS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX"];
const FLEX = ["RB", "WR", "TE"];

/** how many standard deviations of a normal the eighty per cent band spans */
const EIGHTY = 2.5631;

interface Seat {
  key: string;
  position: string;
  actual: number;
  said: Map<string, number>;
}

function lineupFrom(pools: Map<string, Seat[]>, rand: () => number): Seat[] | null {
  const taken = new Set<string>();
  const out: Seat[] = [];

  for (const seat of SEATS) {
    const want = seat === "FLEX" ? FLEX[Math.floor(rand() * 3)]! : seat;
    const pool = pools.get(want) ?? [];

    if (!pool.length) {
      return null;
    }

    let tries = 0;
    let man = pool[Math.floor(rand() * pool.length)]!;

    while (taken.has(man.key) && tries < 20) {
      man = pool[Math.floor(rand() * pool.length)]!;
      tries++;
    }

    if (taken.has(man.key)) {
      return null;
    }

    taken.add(man.key);
    out.push(man);
  }

  return out;
}

interface Brier {
  total: number;
  pairs: number;
}

interface Side {
  middle: number;
  varianceSum: number;
}

function sideOf(
  line: Seat[], name: string, model: ResidualModel,
): Side | null {
  let middle = 0;
  let varianceSum = 0;

  for (const man of line) {
    const said = man.said.get(name);

    if (said === undefined) {
      return null;
    }

    const low = outcomeQuantile(model, man.position, said, 0.1);
    const high = outcomeQuantile(model, man.position, said, 0.9);
    const sd = Math.max(1, (high - low) / EIGHTY);
    middle += said;
    varianceSum += sd * sd;
  }

  return { middle, varianceSum };
}

/**
 * Random legal lineups paired off, each side totalled under one
 * candidate, and the favourite's win chance read off a normal whose
 * spread is the residual model's eighty per cent band. Every candidate
 * sees the same lineups, so the numbers can be read against each other.
 * They are not the copula draws the app ships, so they say nothing about
 * whether the app's own odds are calibrated.
 */
function scoreMatchups(
  seats: Seat[],
  residuals: Map<number, ResidualModel>,
  names: string[],
  rand: () => number,
  into: Map<string, Brier>,
): void {
  const pools = new Map<string, Seat[]>();

  for (const seat of seats) {
    pools.set(seat.position, [...(pools.get(seat.position) ?? []), seat]);
  }

  if (!POSITIONS.every((p) => (pools.get(p) ?? []).length > 8)) {
    return;
  }

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

    const iWin = mine.reduce((s, m) => s + m.actual, 0) >
      theirs.reduce((s, m) => s + m.actual, 0);

    for (const name of names) {
      for (const [buckets, model] of residuals) {
        const a = sideOf(mine, name, model);
        const b = sideOf(theirs, name, model);

        if (!a || !b) {
          continue;
        }

        const sd = Math.sqrt(a.varianceSum + b.varianceSum);
        const raw = normalCdf((a.middle - b.middle) / sd);
        const favoured = raw >= 0.5;
        const p = favoured ? raw : 1 - raw;
        const won = favoured === iWin ? 1 : 0;
        const label = buckets === 5 ? name : `${name} [${buckets} buckets]`;
        const tally = into.get(label) ?? { total: 0, pairs: 0 };
        tally.total += (p - won) * (p - won);
        tally.pairs++;
        into.set(label, tally);
      }
    }
  }
}

/** which candidates get a matchup number, being those with a full line */
const BRIERED = [
  "ours (shipped ridge)", "sleeper", "blend 0.5", "(a) component",
  "(a) component, blend 0.5",
];

async function main(): Promise<void> {
  const games = await loadGames();
  const priors = await positionPriors();
  const teams = teamWeeks(games);
  const sleeper = await loadSleeperWeekly();
  const train: WeeklyExample[] = [];

  for (const season of TRAIN) {
    train.push(...(await weeklyExamplesForSeason(season, games)));
  }

  const weekly = fitWeeklyByPosition(train);
  const trainingPoints = train.map((e) => ({
    position: e.position,
    predicted: predictWeeklyByPosition(weekly, e),
    actual: e.target,
  }));
  const residuals = new Map<number, ResidualModel>(
    [5, 10, 20].map((buckets) =>
      [buckets, buildResidualModel(trainingPoints, buckets)]),
  );
  const ridge = new Map<string, number>();

  for (const season of TEST) {
    for (const e of await weeklyExamplesForSeason(season, games)) {
      ridge.set(
        `${season}|${e.week}|${e.playerId}`,
        predictWeeklyByPosition(weekly, e),
      );
    }
  }

  const tallies = new Map<string, Cell>();
  const walkTallies = new Map<string, Cell>();
  const briers = new Map<string, Brier>();
  const walk = await loadWalkWeekly();
  const rand = mulberry32(20240901);
  let rows = 0;

  for (const season of TEST) {
    const byWeek = new Map<number, Row[]>();

    for (const row of await rowsFor(season, teams, sleeper, ridge, walk)) {
      byWeek.set(row.week, [...(byWeek.get(row.week) ?? []), row]);
    }

    for (const [week, weekRows] of [...byWeek].sort((a, b) => a[0] - b[0])) {
      const seats: Seat[] = [];

      for (const row of weekRows) {
        const prior = priors.get(row.position)!;
        const group = groupOf(week);
        const said = new Map<string, number>();
        rows++;

        for (const candidate of CANDIDATES) {
          const points = candidate.of(row, prior);

          if (points === undefined || !Number.isFinite(points)) {
            continue;
          }

          said.set(candidate.name, points);
          const key = `${candidate.name}|${row.position}|${group}`;
          const usage = candidate.usage?.(row, prior);
          const into = row.walkTouches === undefined
            ? [tallies]
            : [tallies, walkTallies];

          for (const table of into) {
            const cell = table.get(key) ?? emptyCell();
            cell.n++;
            cell.absError += Math.abs(points - row.actual.points);
            cell.bias += points - row.actual.points;

            if (usage) {
              cell.usageRows++;
              cell.targetsAbs += Math.abs(usage.targets - row.actual.targets);
              cell.carriesAbs += Math.abs(usage.carries - row.actual.carries);
            }

            table.set(key, cell);
          }
        }

        const blend = said.get("blend 0.5");

        if (blend !== undefined && blend >= LOW_BAR) {
          seats.push({
            key: `${row.playerId}|${season}|${week}`,
            position: row.position,
            actual: row.actual.points,
            said,
          });
        }
      }

      scoreMatchups(seats, residuals, BRIERED, rand, briers);
    }
  }

  console.log(
    `2024 and 2025, weeks 1 to ${LAST_WEEK}, ${rows} player-weeks, full PPR`);
  showPoints("points per man per week, every week", tallies);
  showUsage(tallies);
  showPoints(
    "points per man per week, only the weeks the walk has played", walkTallies);
  showBands(residuals);
  console.log("\nmatchup brier, normal approximation, same lineups throughout");

  const ranked = [...briers]
    .sort((a, b) => a[1].total / a[1].pairs - b[1].total / b[1].pairs);

  for (const [label, tally] of ranked) {
    console.log(
      `  ${label.padEnd(42)} ${(tally.total / tally.pairs).toFixed(4)}  ` +
      `(${tally.pairs} pairs)`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
