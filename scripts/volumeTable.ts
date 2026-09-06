/**
 * Does redistributing an absent man's touches project volume better than
 * his room's rolling average does?
 *
 * Three projections of the same thing, scored against what happened:
 * Sleeper's own carry and target counts, our last-four average, and that
 * average after the men who are out hand their work on. The slice that
 * matters is the weeks where somebody's job changed, which is where a
 * rolling average has nothing to go on.
 *
 * Run: npx tsx scripts/volumeTable.ts [--test 2024,2025]
 */

import { loadGames } from "../src/data/nflverse.js";
import {
  loadSleeperWeekly,
  projectionKey,
} from "../src/data/sleeperProjections.js";
import type { WeeklyExample } from "../src/features/weekly.js";
import { weeklyExamplesForSeason } from "../src/features/weeklyModel.js";

const LAST_WEEK = 17;

interface Row {
  e: WeeklyExample;
  sleeperCarries: number;
  sleeperTargets: number;
}

const mean = (values: number[]) =>
  values.reduce((s, x) => s + x, 0) / Math.max(1, values.length);

function correlation(a: number[], b: number[]): number {
  const ma = mean(a);
  const mb = mean(b);
  const sd = (values: number[], m: number) =>
    Math.sqrt(mean(values.map((x) => (x - m) ** 2)));
  const spread = sd(a, ma) * sd(b, mb);

  if (spread === 0) {
    return NaN;
  }

  return mean(a.map((x, i) => (x - ma) * (b[i]! - mb))) / spread;
}

const f2 = (x: number) => (Number.isNaN(x) ? "     -" : x.toFixed(2).padStart(6));

interface Kind {
  name: string;
  positions: string[];
  actual(e: WeeklyExample): number;
  sleeper(r: Row): number;
  recent(e: WeeklyExample): number;
  expected(e: WeeklyExample): number;
}

const KINDS: Kind[] = [
  {
    name: "RB carries",
    positions: ["RB"],
    actual: (e) => e.targetCarries,
    sleeper: (r) => r.sleeperCarries,
    recent: (e) => e.carriesRecent,
    expected: (e) => e.carriesExpected,
  },
  {
    name: "WR/TE targets",
    positions: ["WR", "TE"],
    actual: (e) => e.targetTargets,
    sleeper: (r) => r.sleeperTargets,
    recent: (e) => e.targetsRecent,
    expected: (e) => e.targetsExpected,
  },
];

/**
 * The weeks where Sleeper's own count moved a long way off the man's
 * recent average, which is the probe's reading of whose job changed.
 * It is Sleeper's call rather than ours, so our adjustment cannot pick
 * the slice it is scored on.
 */
function jobChanged(kind: Kind, row: Row): boolean {
  const recent = kind.recent(row.e);
  const theirs = kind.sleeper(row);
  const floor = kind.name.startsWith("RB") ? 4 : 3;

  return (
    theirs >= 2 * Math.max(1, recent) || (recent >= floor && theirs <= 0.5 * recent)
  );
}

/** the same question asked from our side: somebody in his room is out */
function roomChanged(kind: Kind, row: Row): boolean {
  return Math.abs(kind.expected(row.e) - kind.recent(row.e)) >= 0.5;
}

function report(label: string, kind: Kind, rows: Row[]): void {
  if (rows.length < 20) {
    console.log(`${label.padEnd(34)} n=${String(rows.length).padStart(5)}  too few`);
    return;
  }

  const actual = rows.map((r) => kind.actual(r.e));
  const columns: [string, number[]][] = [
    ["sleeper", rows.map((r) => kind.sleeper(r))],
    ["last four", rows.map((r) => kind.recent(r.e))],
    ["adjusted", rows.map((r) => kind.expected(r.e))],
  ];
  const corr = columns
    .map(([name, values]) => `${name} ${f2(correlation(values, actual))}`)
    .join("  ");
  const mae = columns
    .map(
      ([name, values]) =>
        `${name} ${f2(mean(values.map((x, i) => Math.abs(x - actual[i]!))))}`,
    )
    .join("  ");

  console.log(
    `${label.padEnd(34)} n=${String(rows.length).padStart(5)}  corr ${corr}   mae ${mae}`,
  );
}

function parseList(arg: string | undefined, fallback: number[]): number[] {
  if (!arg) {
    return fallback;
  }

  return arg.split(",").map(Number);
}

async function main(): Promise<void> {
  const flag = process.argv.indexOf("--test");
  const seasons = parseList(
    flag === -1 ? undefined : process.argv[flag + 1],
    [2024, 2025],
  );

  const games = await loadGames();
  const projections = await loadSleeperWeekly();

  console.log(
    `projecting volume itself, weeks 1-${LAST_WEEK}, men Sleeper covers\n`,
  );

  for (const season of seasons) {
    const rows: Row[] = [];

    for (const e of await weeklyExamplesForSeason(season, games)) {
      const p = projections.get(projectionKey(e.season, e.week, e.playerId));
      const played = e.targetTargets + e.targetCarries > 0 || e.target !== 0;

      if (!p || !played || e.week > LAST_WEEK) {
        continue;
      }

      rows.push({ e, sleeperCarries: p.carries, sleeperTargets: p.targets });
    }

    console.log(`== ${season} ==`);

    for (const kind of KINDS) {
      const mine = rows.filter((r) => kind.positions.includes(r.e.position));
      report(`${kind.name}, all`, kind, mine);
      report(
        `${kind.name}, job change`,
        kind,
        mine.filter((r) => jobChanged(kind, r)),
      );
      report(
        `${kind.name}, no job change`,
        kind,
        mine.filter((r) => !jobChanged(kind, r)),
      );
      report(
        `${kind.name}, room man out`,
        kind,
        mine.filter((r) => roomChanged(kind, r)),
      );
    }

    console.log("");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
