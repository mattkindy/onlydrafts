/**
 * Does a coordinator have a number of his own?
 *
 * A team's before-contact yards predict nothing about a particular
 * back, which killed the idea of handing him his side's number. But a
 * side is the wrong entity. The scheme belongs to the coordinator, and
 * he takes it with him.
 *
 * So pool every back a coordinator has ever had, leave out the one
 * being asked about, and see whether the rest of them say anything.
 * The same question for his old team is the control.
 *
 * Run: npx tsx scripts/coordinatorRunEval.ts
 */

import { spearman } from "../src/backtest/metrics.js";
import { loadCoaches } from "../src/data/coaches.js";
import { loadRushingSeasons } from "../src/data/advancedStats.js";
import { asTeam } from "../src/features/runParts.js";

const noise = (n: number) => 1 / Math.sqrt(Math.max(2, n - 1));

interface BackSeason {
  coordinator: string;
  team: string;
  season: number;
  back: string;
  carries: number;
  before: number;
  after: number;
}

/** everybody else's average, so nobody predicts himself */
function leavingOut(
  rows: BackSeason[], keyOf: (row: BackSeason) => string,
  of: (row: BackSeason) => number, apartFrom: (row: BackSeason, other: BackSeason) => boolean,
): { said: number[]; truth: number[]; count: number } {
  const grouped = new Map<string, BackSeason[]>();

  for (const row of rows) {
    const key = keyOf(row);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  const said: number[] = [];
  const truth: number[] = [];

  for (const row of rows) {
    const others = (grouped.get(keyOf(row)) ?? [])
      .filter((other) => apartFrom(row, other));

    if (!others.length) {
      continue;
    }

    const carries = others.reduce((sum, o) => sum + o.carries, 0);
    said.push(others.reduce((sum, o) => sum + of(o) * o.carries, 0) / carries);
    truth.push(of(row));
  }

  return { said, truth, count: said.length };
}

async function main(): Promise<void> {
  const coaches = await loadCoaches();
  const rows: BackSeason[] = [];
  let unknown = 0;

  for (const row of await loadRushingSeasons(40)) {
    const team = asTeam(row.team);
    const coordinator = coaches.get(`${team}|${row.season}|OC`) ?? "";

    if (!coordinator) {
      unknown++;
      continue;
    }

    rows.push({
      coordinator, team, season: row.season, back: row.pfrId,
      carries: row.attempts, before: row.beforeContact, after: row.afterContact,
    });
  }

  console.log(
    `${rows.length} back seasons under a known coordinator, ${unknown} without\n`,
  );

  const ways: [string, (row: BackSeason) => string,
    (row: BackSeason, other: BackSeason) => boolean][] = [
    [
      "his coordinator's other backs",
      (row) => row.coordinator,
      (row, other) => other.back !== row.back || other.season !== row.season,
    ],
    [
      "  and only where they were another man",
      (row) => row.coordinator,
      (row, other) => other.back !== row.back,
    ],
    [
      "  and only where it was another team",
      (row) => row.coordinator,
      (row, other) => other.back !== row.back && other.team !== row.team,
    ],
    [
      "his team's other backs, whoever ran it",
      (row) => row.team,
      (row, other) => other.back !== row.back,
    ],
    [
      "the same back elsewhere",
      (row) => row.back,
      (row, other) => other.season !== row.season,
    ],
  ];

  console.log(
    "guessing a back's season, as rank correlation, more is better\n",
  );
  console.log(
    "  what we ask                                n   before contact" +
      "   after contact   give or take",
  );

  for (const [label, keyOf, apartFrom] of ways) {
    const before = leavingOut(rows, keyOf, (r) => r.before, apartFrom);
    const after = leavingOut(rows, keyOf, (r) => r.after, apartFrom);

    if (before.count < 20) {
      console.log("  " + label.padEnd(42) + String(before.count).padStart(4) +
        "   too few to say");
      continue;
    }

    console.log(
      "  " + label.padEnd(42) + String(before.count).padStart(4) +
        spearman(before.said, before.truth).toFixed(3).padStart(17) +
        spearman(after.said, after.truth).toFixed(3).padStart(16) +
        noise(before.count).toFixed(3).padStart(15),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
