/**
 * Start/sit scored the way a manager pays for it: points scored and
 * points left on the bench.
 *
 * Pair accuracy asks who was better between two men. What a manager
 * does is pick eight starters out of fourteen, so this drafts plausible
 * twelve-team leagues off preseason ADP, sets each roster's lineup every
 * week by each method, and adds up what the starters really scored.
 * Perfect hindsight is the ceiling and the gap to it is the bench cost.
 *
 * A man on a bye has no row and cannot be started. An inactive man does
 * have a row, of zeroes, and starting him costs what it costs in life.
 * Run: npx tsx scripts/lineupEval.ts [--seasons 2024,2025] [--leagues 200]
 */

import { loadAdp, type AdpEntry } from "../src/data/adp.js";
import { normalizeName } from "../src/data/names.js";
import { loadGames } from "../src/data/nflverse.js";
import {
  loadSleeperWeekly,
  projectionKey,
} from "../src/data/sleeperProjections.js";
import {
  fitWeeklyByPosition,
  predictWeeklyByPosition,
} from "../src/features/fitWeeklyByPosition.js";
import { blendPoints, SHIPPED_BLEND_WEIGHT } from "../src/features/sleeperBlend.js";
import type { WeeklyExample } from "../src/features/weekly.js";
import { weeklyExamplesForSeason } from "../src/features/weeklyModel.js";
import {
  pickLineup,
  startersNeeded,
  THREE_RECEIVER_FORMAT,
  type LineupCandidate,
} from "../src/sim/lineup.js";
import { seededRng } from "../src/sim/rng.js";

const TRAIN_FROM = 2016;
const POSITIONS = ["QB", "RB", "WR", "TE"];
const FORMAT = THREE_RECEIVER_FORMAT;
const TEAMS = 12;
const ROUNDS = 14;
const LAST_FANTASY_WEEK = 17;

/** as many of a position as a manager will carry, and as few as he dares */
const CAPS: Record<string, number> = { QB: 3, RB: 6, WR: 7, TE: 3 };
const MINIMUMS: Record<string, number> = { QB: 1, RB: 3, WR: 4, TE: 1 };

/** a lineup is only a decision when there is somebody to sit */
const SMALLEST_CHOICE = startersNeeded(FORMAT) + 1;

/** within this much of perfect and the manager left nothing behind */
const CLOSE_ENOUGH = 1;

interface Draftee {
  playerId: string;
  position: string;
  adp: number;
}

function gauss(rng: () => number): number {
  const u = Math.max(rng(), Number.MIN_VALUE);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/**
 * ADP has no gsis ids, so a man is matched by his normalized name and
 * position. When two men share both, the one with more weeks on the
 * field is the one the drafters meant.
 */
function draftBoard(
  adp: Map<string, AdpEntry>,
  examples: WeeklyExample[],
): Draftee[] {
  const weeks = new Map<string, { playerId: string; count: number }>();

  for (const e of examples) {
    if (!POSITIONS.includes(e.position)) {
      continue;
    }

    const key = `${normalizeName(e.playerName)}|${e.position}`;
    const already = weeks.get(key);
    weeks.set(key, {
      playerId: already?.playerId ?? e.playerId,
      count: (already?.count ?? 0) + 1,
    });
  }

  const board: Draftee[] = [];

  for (const [key, entry] of adp) {
    const match = weeks.get(key);

    if (!match || !POSITIONS.includes(entry.position)) {
      continue;
    }

    board.push({
      playerId: match.playerId,
      position: entry.position,
      adp: entry.adp,
    });
  }

  return board.sort((a, b) => a.adp - b.adp);
}

/** how many more men a team must take to be able to field a lineup */
function stillNeeded(have: Record<string, number>): number {
  return POSITIONS.reduce(
    (sum, p) => sum + Math.max(0, MINIMUMS[p]! - (have[p] ?? 0)),
    0,
  );
}

function canTake(
  position: string,
  have: Record<string, number>,
  picksLeft: number,
): boolean {
  if ((have[position] ?? 0) >= CAPS[position]!) {
    return false;
  }

  const short = (have[position] ?? 0) < MINIMUMS[position]!;
  return short || picksLeft > stillNeeded(have);
}

/**
 * One snake draft. Every league shifts the board a little, so two
 * leagues disagree about who was worth a second round pick, and each
 * pick wobbles again, so two teams in the same league reach for
 * different men. Positional caps keep anybody from taking nine backs.
 */
function draftLeague(board: Draftee[], rng: () => number): string[][] {
  const value = new Map<string, number>(
    board.map((man) => [man.playerId, man.adp + 6 * gauss(rng)]),
  );
  const rosters: string[][] = Array.from({ length: TEAMS }, () => []);
  const counts: Record<string, number>[] = Array.from({ length: TEAMS }, () => ({}));
  const taken = new Set<string>();

  for (let round = 0; round < ROUNDS; round++) {
    const order = round % 2 === 0
      ? [...rosters.keys()]
      : [...rosters.keys()].reverse();

    for (const team of order) {
      const have = counts[team]!;
      const picksLeft = ROUNDS - rosters[team]!.length;
      let best: Draftee | undefined;
      let bestValue = Infinity;

      for (const man of board) {
        if (taken.has(man.playerId) || !canTake(man.position, have, picksLeft)) {
          continue;
        }

        const at = value.get(man.playerId)! + 4 * gauss(rng);

        if (at < bestValue) {
          best = man;
          bestValue = at;
        }
      }

      if (!best) {
        continue;
      }

      taken.add(best.playerId);
      rosters[team]!.push(best.playerId);
      have[best.position] = (have[best.position] ?? 0) + 1;
    }
  }

  return rosters;
}

type Score = (e: WeeklyExample) => number;

interface Method {
  name: string;
  score: Score;
}

interface Tally {
  weeks: number;
  points: number;
  bench: number;
  close: number;
  /** per league, so the spread across leagues says whether this is settled */
  byLeague: number[];
}

function emptyTally(): Tally {
  return { weeks: 0, points: 0, bench: 0, close: 0, byLeague: [] };
}

function pointsFor(
  candidates: WeeklyExample[],
  byId: Map<string, WeeklyExample>,
  score: Score,
): number {
  const lineup: LineupCandidate[] = candidates.map((e) => ({
    playerId: e.playerId,
    position: e.position,
    score: score(e),
  }));

  let total = 0;

  for (const playerId of pickLineup(lineup, FORMAT)) {
    total += byId.get(playerId)!.target;
  }

  return total;
}

function mean(values: number[]): number {
  return values.reduce((s, x) => s + x, 0) / values.length;
}

/** spread of the league means, which is the error bar on the table */
function standardError(values: number[]): number {
  if (values.length < 2) {
    return NaN;
  }

  const average = mean(values);
  const variance =
    values.reduce((s, x) => s + (x - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance / values.length);
}

function groupByWeek(
  examples: WeeklyExample[],
): Map<number, Map<string, WeeklyExample>> {
  const weeks = new Map<number, Map<string, WeeklyExample>>();

  for (const e of examples) {
    if (e.week > LAST_FANTASY_WEEK || !POSITIONS.includes(e.position)) {
      continue;
    }

    const week = weeks.get(e.week) ?? new Map();
    week.set(e.playerId, e);
    weeks.set(e.week, week);
  }

  return weeks;
}

function parseList(arg: string | undefined, fallback: number[]): number[] {
  if (!arg) {
    return fallback;
  }

  return arg.split(",").map(Number);
}

function flagValue(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function main(): Promise<void> {
  const seasons = parseList(flagValue("--seasons"), [2024, 2025]);
  const leagues = Number(flagValue("--leagues") ?? 200);
  const games = await loadGames();
  const projections = await loadSleeperWeekly();
  const cache = new Map<number, WeeklyExample[]>();

  for (let season = TRAIN_FROM; season <= Math.max(...seasons); season++) {
    cache.set(season, await weeklyExamplesForSeason(season, games));
  }

  console.log(
    `lineups set out of a ${ROUNDS}-man roster in a ${TEAMS}-team league: ` +
      "1 QB, 2 RB, 3 WR, 1 TE, 1 flex",
  );
  console.log(
    `${leagues} leagues a season, drafted snake order off preseason PPR ADP with noise`,
  );
  console.log(
    "points is what the starters really scored, bench is how far behind the perfect",
  );
  console.log(
    `hindsight lineup, close is the share of weeks within ${CLOSE_ENOUGH} point of perfect.\n`,
  );

  for (const season of seasons) {
    const train = [...cache.keys()]
      .filter((s) => s < season)
      .flatMap((s) => cache.get(s)!);
    const model = fitWeeklyByPosition(train);
    const examples = cache.get(season)!;
    const weeks = groupByWeek(examples);
    const board = draftBoard(await loadAdp(season, "ppr"), examples);

    // Every method has to say something about every man on the roster,
    // and Sleeper does not cover them all, so a man Sleeper has no
    // number for is scored by his own form instead.
    const own: Score = (e) => (e.seasonPpg > 0 ? e.seasonPpg : e.prevPpg);
    const ourPoints = new Map<WeeklyExample, number>();
    const theirPoints = new Map<WeeklyExample, number>();
    let covered = 0;
    let asked = 0;

    const drafted = new Set(board.map((man) => man.playerId));

    for (const byId of weeks.values()) {
      for (const e of byId.values()) {
        ourPoints.set(e, predictWeeklyByPosition(model, e));
        const found = projections.get(projectionKey(e.season, e.week, e.playerId));
        theirPoints.set(e, found ? found.points : own(e));

        if (drafted.has(e.playerId)) {
          asked++;
          covered += found ? 1 : 0;
        }
      }
    }

    const ours: Score = (e) => ourPoints.get(e)!;
    const sleeper: Score = (e) => theirPoints.get(e)!;
    const methods: Method[] = [
      { name: "his season average", score: own },
      { name: "our ridge", score: ours },
      { name: "sleeper", score: sleeper },
      {
        name: "the shipped blend",
        score: (e) => blendPoints(ours(e), sleeper(e), SHIPPED_BLEND_WEIGHT),
      },
      { name: "perfect hindsight", score: (e) => e.target },
    ];

    const tallies = methods.map(() => emptyTally());
    const rng = seededRng(season * 1000 + 7);
    let rosterWeeks = 0;

    for (let league = 0; league < leagues; league++) {
      const leagueTotals = methods.map(() => ({ weeks: 0, bench: 0 }));

      for (const roster of draftLeague(board, rng)) {
        for (const byId of weeks.values()) {
          const candidates = roster
            .map((id) => byId.get(id))
            .filter((e): e is WeeklyExample => e !== undefined);

          if (candidates.length < SMALLEST_CHOICE) {
            continue;
          }

          rosterWeeks++;
          const best = pointsFor(candidates, byId, (e) => e.target);

          methods.forEach((method, i) => {
            const points = pointsFor(candidates, byId, method.score);
            const tally = tallies[i]!;
            tally.weeks++;
            tally.points += points;
            tally.bench += best - points;
            tally.close += best - points <= CLOSE_ENOUGH ? 1 : 0;
            leagueTotals[i]!.weeks++;
            leagueTotals[i]!.bench += best - points;
          });
        }
      }

      methods.forEach((_, i) => {
        const totals = leagueTotals[i]!;
        tallies[i]!.byLeague.push(totals.bench / totals.weeks);
      });
    }

    const played = [...weeks.keys()].sort((a, b) => a - b);
    console.log(
      `${season}, weeks ${played[0]} to ${played[played.length - 1]}: ` +
        `${board.length} drafted men matched to ADP, ${rosterWeeks} roster-weeks ` +
        `with at least ${SMALLEST_CHOICE} men to choose from, sleeper covers ` +
        `${((covered / Math.max(asked, 1)) * 100).toFixed(1)}% of the calls`,
    );

    for (const [i, method] of methods.entries()) {
      const tally = tallies[i]!;
      const error = standardError(tally.byLeague);
      console.log(
        `  ${method.name.padEnd(19)} ${(tally.points / tally.weeks)
          .toFixed(1)
          .padStart(6)} points a week, ` +
          `${(tally.bench / tally.weeks).toFixed(2).padStart(5)} left on the bench ` +
          `(+/- ${error.toFixed(2)}), ` +
          `${((tally.close / tally.weeks) * 100).toFixed(1).padStart(4)}% of weeks within a point`,
      );
    }

    console.log("");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
