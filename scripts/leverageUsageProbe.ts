/**
 * Asks whether a player's leverage weighted share of his side's work
 * through a week orders his next four weeks of scoring better than his
 * raw share does. That is the question the whole idea rests on, so if the
 * answer is no the weighting should not be wired into anything.
 *
 * It reads the counted file rather than the play by play, so it runs in
 * seconds. `LEVERAGE_SHAPE=margin` reads the other file and reports the
 * other shape.
 * Run: npx tsx scripts/leverageUsageProbe.ts [--seasons 2015-2025]
 */

import { loadPlayerStats } from "../src/data/nflverse.js";
import { seasonsAsked } from "../src/data/seasons.js";
import { spearman } from "../src/backtest/metrics.js";
import { fantasyPoints, scoringRules } from "../src/scoring/fantasyPoints.js";
import { LEVERAGE_SHAPE } from "../src/model/leverage.js";
import { leverageUsage, loadLeverage } from "../src/features/leverageUsage.js";

const SEASONS = Array.from({ length: 11 }, (_, i) => 2015 + i);

/** how far ahead the question looks, and the weeks it can be asked from */
const AHEAD = 4;
const FIRST_WEEK = 4;
const LAST_WEEK = 13;

/** below this his share is a handful of touches and says nothing */
const MIN_WORK = 20;
/** and below this his points a game is one good afternoon */
const MIN_GAMES = 2;

/**
 * Where a rotational player stops and a starter begins. The idea is about
 * telling a backup being worked in from one who only plays when the game
 * is gone, and pooling every starter in with them would hide it.
 */
const ROTATIONAL = 0.15;

const POSITIONS = ["RB", "WR", "TE"] as const;
const RULES = scoringRules("ppr");

interface Pair {
  season: number;
  week: number;
  raw: number;
  weighted: number;
  /** what his shrunk trend said, and how his scoring actually moved */
  trend: number;
  moved: number;
  was: number;
}

function pointsBy(
  weeks: Awaited<ReturnType<typeof loadPlayerStats>>,
): Map<string, Map<number, number>> {
  const byPlayer = new Map<string, Map<number, number>>();

  for (const week of weeks) {
    const his = byPlayer.get(week.playerId) ?? new Map<number, number>();
    his.set(week.week, fantasyPoints(week.statLine, RULES));
    byPlayer.set(week.playerId, his);
  }

  return byPlayer;
}

function positionsIn(
  weeks: Awaited<ReturnType<typeof loadPlayerStats>>,
): Map<string, string> {
  const byPlayer = new Map<string, string>();

  for (const week of weeks) {
    if (week.position) {
      byPlayer.set(week.playerId, week.position);
    }
  }

  return byPlayer;
}

/** his points a game over a stretch of weeks, and how many he played */
function perGame(
  his: Map<number, number> | undefined, from: number, to: number,
): { points: number; games: number } {
  let points = 0;
  let games = 0;

  for (let week = from; week <= to; week++) {
    const scored = his?.get(week);

    if (scored === undefined) {
      continue;
    }

    points += scored;
    games++;
  }

  return { points: games > 0 ? points / games : 0, games };
}

const rank = (pairs: Pair[], said: (pair: Pair) => number) =>
  pairs.length < 2 ? 0 : spearman(pairs.map(said), pairs.map((p) => p.was));

const weekly = (pair: Pair) => `${pair.season}|${pair.week}`;
const yearly = (pair: Pair) => String(pair.season);

function cohortsOf(pairs: Pair[], by: (pair: Pair) => string): Pair[][] {
  const cohorts = new Map<string, Pair[]>();

  for (const pair of pairs) {
    const key = by(pair);
    const cohort = cohorts.get(key) ?? [];
    cohort.push(pair);
    cohorts.set(key, cohort);
  }

  return [...cohorts.values()].filter((cohort) => cohort.length >= 10);
}

/** the mean of the rank correlation inside each season and week on its own */
function byCohort(pairs: Pair[], said: (pair: Pair) => number): number {
  const cohorts = cohortsOf(pairs, weekly);
  const total = cohorts.reduce((sum, cohort) => sum + rank(cohort, said), 0);

  return cohorts.length > 0 ? total / cohorts.length : 0;
}

/**
 * How many of the cohorts the weighted share ordered better in. A pooled
 * gain of two hundredths could be one season carrying the rest, and a
 * split near fifty fifty would say so. The ten weeks of one season share
 * most of their players, so the count by season is the harder test.
 */
function won(pairs: Pair[], by: (pair: Pair) => string): string {
  const cohorts = cohortsOf(pairs, by);
  const ahead = cohorts.filter(
    (cohort) => rank(cohort, (p) => p.weighted) > rank(cohort, (p) => p.raw),
  ).length;

  return `${ahead}/${cohorts.length}`;
}

function report(title: string, rows: Map<string, Pair[]>): void {
  console.log(`\n${title}`);
  console.log(
    "position  measure       raw    leverage   within a week   weeks won" +
    "  seasons  agree   pairs",
  );

  for (const [label, pairs] of rows) {
    const [position, measure] = label.split("|");
    const agree = pairs.length < 2
      ? 0 : spearman(pairs.map((p) => p.raw), pairs.map((p) => p.weighted));
    console.log(
      `${(position ?? "").padEnd(9)} ${(measure ?? "").padEnd(13)}` +
      ` ${rank(pairs, (p) => p.raw).toFixed(3)}` +
      `  ${rank(pairs, (p) => p.weighted).toFixed(3)}` +
      `     ${byCohort(pairs, (p) => p.raw).toFixed(3)} /` +
      ` ${byCohort(pairs, (p) => p.weighted).toFixed(3)}` +
      `    ${won(pairs, weekly).padStart(7)}` +
      `    ${won(pairs, yearly).padStart(5)}` +
      `  ${agree.toFixed(3)} ${String(pairs.length).padStart(7)}`,
    );
  }
}

/**
 * The trend is asked the question it is for: does a share that has been
 * rising over three weeks go with scoring that rises over the next four.
 * Adding it to the level instead would only ask whether a share plus a
 * small number orders better than the share, which it cannot.
 */
function trendReport(rows: Map<string, Pair[]>): void {
  console.log("\nthe shrunk trend against how his points a game moved");
  console.log("position  measure       trend    pairs");

  for (const [label, pairs] of rows) {
    const [position, measure] = label.split("|");
    const said = pairs.map((p) => p.trend);
    const moved = pairs.map((p) => p.moved);
    console.log(
      `${(position ?? "").padEnd(9)} ${(measure ?? "").padEnd(13)}` +
      ` ${(pairs.length < 2 ? 0 : spearman(said, moved)).toFixed(3)}` +
      ` ${String(pairs.length).padStart(8)}`,
    );
  }
}

const sorted = (rows: Map<string, Pair[]>) =>
  new Map([...rows.entries()].sort(([one], [other]) => one.localeCompare(other)));

async function main(): Promise<void> {
  const seasons = seasonsAsked(process.argv, SEASONS);
  const counted = await loadLeverage(seasons);
  const everyone = new Map<string, Pair[]>();
  const rotational = new Map<string, Pair[]>();
  const push = (rows: Map<string, Pair[]>, label: string, pair: Pair) => {
    const into = rows.get(label) ?? [];
    into.push(pair);
    rows.set(label, into);
  };

  for (const season of seasons) {
    const rowsIn = counted.get(season) ?? [];

    if (rowsIn.length === 0) {
      console.warn(`${season}: nothing counted, so it is left out`);
      continue;
    }

    const weeks = await loadPlayerStats(season);
    const positions = positionsIn(weeks);
    const scored = pointsBy(weeks);

    for (let week = FIRST_WEEK; week <= LAST_WEEK; week++) {
      const usage = leverageUsage(rowsIn, { season, through: week, positions });

      for (const player of usage.values()) {
        const his = scored.get(player.player);
        const next = perGame(his, week + 1, week + AHEAD);
        const already = perGame(his, 1, week);
        const wanted = POSITIONS.includes(
          player.position as (typeof POSITIONS)[number],
        );

        if (player.work < MIN_WORK || next.games < MIN_GAMES || !wanted) {
          continue;
        }

        const at = {
          season, week, was: next.points,
          moved: next.points - already.points,
        };
        const measures = {
          "carry share": {
            raw: player.rawCarryShare,
            weighted: player.carryShare,
            trend: player.carryTrend,
          },
          "target share": {
            raw: player.rawTargetShare,
            weighted: player.targetShare,
            trend: player.targetTrend,
          },
          "work share": {
            raw: player.rawWorkShare,
            weighted: player.workShare,
            trend: player.targetTrend + player.carryTrend,
          },
        };

        for (const [measure, said] of Object.entries(measures)) {
          push(everyone, `${player.position}|${measure}`, { ...at, ...said });

          if (player.rawWorkShare < ROTATIONAL) {
            push(rotational, `${player.position}|${measure}`, { ...at, ...said });
          }
        }
      }
    }
  }

  console.log(
    `seasons ${seasons[0]} to ${seasons[seasons.length - 1]}, weeks ` +
    `${FIRST_WEEK} to ${LAST_WEEK}, leverage weighted by ${LEVERAGE_SHAPE}`,
  );
  console.log(
    `a player is in when he had ${MIN_WORK} targets and carries through the ` +
    `week and played ${MIN_GAMES} of the next ${AHEAD}. "agree" is how ` +
    "closely\nthe two measures order the same players, so a number near " +
    "one says they are the same measure",
  );
  report(
    "rank correlation with points a game over the next four weeks",
    sorted(everyone),
  );
  report(
    `the same, over only the players under ${ROTATIONAL * 100}% of their ` +
    "side's work",
    sorted(rotational),
  );
  trendReport(sorted(everyone));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
