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
  debiasedSleeper,
  SHIPPED_BLEND_WEIGHT,
  SLEEPER_QB_BIAS,
} from "../src/features/sleeperBlend.js";
import {
  loadWalkWeekly,
  walkKey,
  walkWeeklyPathFor,
  type WalkWeekRow,
} from "../src/features/walkWeeklyCache.js";
import { DEALT_WIDER } from "../src/features/walkWeek.js";
import {
  addBox,
  boxOf as componentBoxOf,
  componentPoints,
  componentRates,
  componentUsage as usageForComponent,
  COMPONENT_THROUGH_WEEK,
  COMPONENT_WINDOW,
  emptyBox,
  perGame,
  pointsFrom as pointsFromParts,
  positionRatePriors,
  ratesFrom,
  rawRates,
  scaleUsage,
  usageOf,
  type Box,
  type History,
  type Rates,
  type Usage,
} from "../src/features/componentWeek.js";
import { normalCdf } from "../app/lib/spread.ts";

const RULES = presets.ppr;
const TRAIN = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023];
const TEST = [2024, 2025];
const POSITIONS = ["QB", "RB", "WR", "TE"];
const LAST_WEEK = 17;
const EARLY_THROUGH = COMPONENT_THROUGH_WEEK;
const WINDOW = COMPONENT_WINDOW;
const DEFAULT_IMPLIED = 21.5;

/** a man under this is nobody's starter, so lineups are drawn above it */
const LOW_BAR = 5;
const LINEUPS = 120;

const boxOf = (s: PlayerWeekStats): Box => componentBoxOf(s, RULES);
const pointsFrom = (usage: Usage, rates: Rates): number =>
  pointsFromParts(usage, rates, RULES);

/** the league-average rates the component model shrinks toward */
async function positionPriors(): Promise<Map<string, Rates>> {
  const weeks: PlayerWeekStats[] = [];

  for (const season of TRAIN) {
    weeks.push(...(await loadPlayerStats(season)));
  }

  return positionRatePriors(weeks, RULES);
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
  /** and the same from each variant of the walk that has been played */
  walks: Map<string, WalkWeekRow>;
}

/**
 * The variants of the walk on disk, each played once by
 * scripts/walkWeekCache.ts with `VARIANT` set to the same name.
 */
const VARIANTS = ["component", "component-rates", "component-full"];

async function rowsFor(
  season: number,
  games: Map<string, TeamWeek>,
  sleeper: Map<string, { points: number }>,
  ridge: Map<string, number>,
  walk: Map<string, WalkWeekRow>,
  variants: Map<string, Map<string, WalkWeekRow>>,
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
        walks: new Map(
          [...variants]
            .map(([name, rows]) =>
              [name, rows.get(walkKey(season, s.week, playerId))] as const)
            .filter((pair): pair is [string, WalkWeekRow] =>
              pair[1] !== undefined),
        ),
      });
    });
  }

  return rows;
}

const historyRates = (row: Row, prior: Rates): Rates =>
  componentRates(row, prior);
const baseUsage = (row: History): Usage => usageForComponent(row);

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

/**
 * The line the site ships from week 5 on, and the component line before
 * it, which is the split the numbers below argue for.
 */
function earlyComponentLine(row: Row, prior: Rates): number {
  if (row.week > EARLY_THROUGH) {
    return ourLine(row);
  }

  return componentPoints(row, prior, RULES);
}

/**
 * How many points Sleeper gives a position more than it scores. Sleeper
 * only publishes from 2024, so there is no training season to fit this
 * on: a row's bias comes from the other test season, which keeps the
 * number it is scored against out of its own fit.
 */
const fittedSleeperBias = new Map<string, number>();

function sleeperBiasKey(season: number, position: string): string {
  return `${season}|${position}`;
}

function fitSleeperBias(rows: Row[]): void {
  const sums = new Map<string, { total: number; n: number }>();

  for (const row of rows) {
    if (row.sleeper === undefined) {
      continue;
    }

    const key = sleeperBiasKey(row.season, row.position);
    const cell = sums.get(key) ?? { total: 0, n: 0 };
    cell.total += row.sleeper - row.actual.points;
    cell.n++;
    sums.set(key, cell);
  }

  for (const season of TEST) {
    for (const position of POSITIONS) {
      let total = 0;
      let n = 0;

      for (const other of TEST) {
        if (other === season) {
          continue;
        }

        const cell = sums.get(sleeperBiasKey(other, position));
        total += cell?.total ?? 0;
        n += cell?.n ?? 0;
      }

      fittedSleeperBias.set(sleeperBiasKey(season, position), n ? total / n : 0);
    }
  }
}

const fixedDebiased = (row: Row): number =>
  debiasedSleeper(row.position, row.sleeper!);

const fittedDebiased = (row: Row): number =>
  row.sleeper! -
  (fittedSleeperBias.get(sleeperBiasKey(row.season, row.position)) ?? 0);

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

/**
 * The same swap of touches, from a variant of the walk rather than from
 * the shipped one. A man the variant never dealt keeps his trailing
 * usage, so the row still scores.
 */
function variantUsage(row: Row, variant: string, weight: number): Usage {
  const base = baseUsage(row);
  const touches = base.carries + base.targets;
  const his = row.walks.get(variant);

  if (his === undefined || touches <= 0) {
    return base;
  }

  const wanted = (1 - weight) * touches + weight * his.touches;

  return {
    passAtt: base.passAtt,
    carries: base.carries * (wanted / touches),
    targets: base.targets * (wanted / touches),
  };
}

/**
 * The three ways of reading one variant of the walk: its touches put
 * through the man's own rates, half of that swap, and the walk's own
 * points. Every variant is read the same way, so the rows come from one
 * place and a new variant only has to be named in `VARIANTS`.
 */
function waysOfReading(variant: string): Candidate[] {
  return [
    {
      name: `sim, ${variant}: usage`,
      of: (row, prior) =>
        row.walks.has(variant)
          ? pointsFrom(variantUsage(row, variant, 1), historyRates(row, prior))
          : undefined,
      usage: (row) => variantUsage(row, variant, 1),
    },
    {
      name: `sim, ${variant}: half`,
      of: (row, prior) =>
        row.walks.has(variant)
          ? pointsFrom(
            variantUsage(row, variant, 0.5), historyRates(row, prior))
          : undefined,
      usage: (row) => variantUsage(row, variant, 0.5),
    },
    {
      name: `sim, ${variant}: points`,
      of: (row) => row.walks.get(variant)?.points,
    },
  ];
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
    of: (row, prior) => componentPoints(row, prior, RULES),
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
    name: "component wk1-4, blend 0.5",
    of: (row, prior) =>
      row.sleeper === undefined
        ? undefined
        : blendPoints(
          earlyComponentLine(row, prior), row.sleeper, SHIPPED_BLEND_WEIGHT),
  },
  {
    name: `same, QB debias ${SLEEPER_QB_BIAS}`,
    of: (row, prior) =>
      row.sleeper === undefined
        ? undefined
        : blendPoints(
          earlyComponentLine(row, prior),
          fixedDebiased(row),
          SHIPPED_BLEND_WEIGHT,
        ),
  },
  {
    name: "same, fitted debias",
    of: (row, prior) =>
      row.sleeper === undefined
        ? undefined
        : blendPoints(
          earlyComponentLine(row, prior),
          fittedDebiased(row),
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
  ...VARIANTS.flatMap(waysOfReading),
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

/**
 * How wide the walk's own runs are against how wide a man's weeks
 * really are. The runs say one number: the spread of what he scored
 * across the games he was dealt. The week says another: how far his
 * actual came from the middle of those runs. If the runs are as wide as
 * the weeks, the hand stretch in `DEALT_WIDER` has nothing left to do,
 * and the covered column says how much of the eighty per cent band the
 * runs cover on their own.
 */
function showSpread(rows: Row[], variant: string): void {
  console.log(`\nrun spread against realised, ${variant} walk`);
  console.log(
    `  ${"position".padEnd(10)}${["men", "run sd", "week sd", "covered 80", "covered with 1.2"]
      .map((h) => h.padStart(18)).join("")}`);

  for (const position of POSITIONS) {
    let n = 0;
    let runVariance = 0;
    let weekVariance = 0;
    let inside = 0;
    let insideWider = 0;

    for (const row of rows) {
      if (row.position !== position) {
        continue;
      }

      const runs = row.walks.get(variant)?.dealt ?? [];

      if (runs.length < 10) {
        continue;
      }

      const middle = runs.reduce((a, b) => a + b, 0) / runs.length;
      const variance = runs.reduce((s, x) => s + (x - middle) ** 2, 0) /
        runs.length;
      const sorted = [...runs].sort((a, b) => a - b);
      const at = (q: number) =>
        sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
      const low = at(0.1);
      const high = at(0.9);
      n++;
      runVariance += variance;
      weekVariance += (row.actual.points - middle) ** 2;

      if (row.actual.points >= low && row.actual.points <= high) {
        inside++;
      }

      const wideLow = middle + (low - middle) * DEALT_WIDER;
      const wideHigh = middle + (high - middle) * DEALT_WIDER;

      if (row.actual.points >= wideLow && row.actual.points <= wideHigh) {
        insideWider++;
      }
    }

    if (!n) {
      continue;
    }

    const cells = [
      String(n),
      Math.sqrt(runVariance / n).toFixed(2),
      Math.sqrt(weekVariance / n).toFixed(2),
      `${((100 * inside) / n).toFixed(1)}%`,
      `${((100 * insideWider) / n).toFixed(1)}%`,
    ];
    console.log(
      `  ${position.padEnd(10)}${cells.map((c) => c.padStart(18)).join("")}`);
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
  "(a) component, blend 0.5", "component wk1-4, blend 0.5",
  `same, QB debias ${SLEEPER_QB_BIAS}`, "same, fitted debias",
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
  const variants = new Map<string, Map<string, WalkWeekRow>>([
    ["shipped", walk],
  ]);

  for (const variant of VARIANTS) {
    const rows = await loadWalkWeekly(walkWeeklyPathFor(variant));

    if (rows.size) {
      variants.set(variant, rows);
    }
  }

  const rand = mulberry32(20240901);
  let rows = 0;

  const bySeason = new Map<number, Row[]>();

  for (const season of TEST) {
    bySeason.set(
      season, await rowsFor(season, teams, sleeper, ridge, walk, variants));
  }

  fitSleeperBias([...bySeason.values()].flat());

  for (const season of TEST) {
    const byWeek = new Map<number, Row[]>();

    for (const row of bySeason.get(season) ?? []) {
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
  console.log(
    "\nsleeper's bias fitted on the other test season: " +
    [...fittedSleeperBias].map(([k, v]) => `${k} ${v.toFixed(2)}`).join(", "));
  showPoints("points per man per week, every week", tallies);
  showUsage(tallies);
  showPoints(
    "points per man per week, only the weeks the walk has played", walkTallies);
  showBands(residuals);

  for (const variant of variants.keys()) {
    showSpread([...bySeason.values()].flat(), variant);
  }

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
