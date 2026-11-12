/**
 * Whether the weekly ridge should learn from the season being played.
 *
 * The slate's ridge is fitted on every season from 2016 up to the one
 * before, and never sees a week of the season it is projecting, however
 * many have been played. By week ten that is nine weeks of the very
 * players, schemes and scoring it is asked about, left out.
 *
 * Walk forward over each season scored: for every week from the fourth,
 * three fits predict the same rows. A is the ridge as shipped, the past
 * seasons alone. B adds this season's rows from the weeks already played.
 * C adds them three times over, a recency weight. Each predicts the week's
 * rows, built from games before it as the slate's are, and the three are
 * scored on the same players: pair accuracy within a position in a week,
 * which is what the start and sit calls turn on, and the mean absolute
 * error. Rows are fantasy relevant players, a shipped line of five or more.
 *
 * Run: npx tsx scripts/inSeasonRowsEval.ts
 * EVAL_ONE=2025 scores one season.
 */

import { loadGames } from "../src/data/nflverse.js";
import {
  fitWeeklyByPosition,
  predictWeeklyByPosition,
} from "../src/features/fitWeeklyByPosition.js";
import { weeklyExamplesForSeason } from "../src/features/weeklyModel.js";
import type { WeeklyExample } from "../src/features/weekly.js";
import { addPairs, emptyTally, pairRate } from "../src/backtest/pairs.js";

const TRAIN_FROM = 2016;
const EVAL_SEASONS = Number(process.env["EVAL_ONE"] ?? 0)
  ? [Number(process.env["EVAL_ONE"])]
  : [2024, 2025, 2026];
const FIRST_WEEK = 4;
const POSITIONS = ["QB", "RB", "WR", "TE"];
const RELEVANT = 5;
/** how many times over the recent weight counts this season's rows */
const RECENT_WEIGHT = 3;

type Variant = "A shipped" | "B + this season" | "C + this season x3";
const VARIANTS: Variant[] = ["A shipped", "B + this season", "C + this season x3"];

interface Scored {
  week: number;
  position: string;
  predicted: number;
  actual: number;
}

const games = await loadGames();
const rowsBySeason = new Map<number, WeeklyExample[]>();

async function rowsFor(season: number): Promise<WeeklyExample[]> {
  const held = rowsBySeason.get(season);

  if (held) {
    return held;
  }

  const built = (await weeklyExamplesForSeason(season, games))
    .filter((e) => POSITIONS.includes(e.position));

  rowsBySeason.set(season, built);
  return built;
}

const pooled = new Map<Variant, Scored[]>(VARIANTS.map((v) => [v, []]));

for (const season of EVAL_SEASONS) {
  const past: WeeklyExample[] = [];

  for (let s = TRAIN_FROM; s < season; s++) {
    past.push(...(await rowsFor(s)));
  }

  const now = await rowsFor(season);
  const weeks = [...new Set(now.map((e) => e.week))].filter((w) => w >= FIRST_WEEK).sort((a, b) => a - b);

  if (!weeks.length) {
    console.log(`${season}: no weeks from ${FIRST_WEEK} played yet`);
    continue;
  }

  const shipped = fitWeeklyByPosition(past);
  const bySeason = new Map<Variant, Scored[]>(VARIANTS.map((v) => [v, []]));

  for (const week of weeks) {
    const before = now.filter((e) => e.week < week);
    const fits: Record<Variant, ReturnType<typeof fitWeeklyByPosition>> = {
      "A shipped": shipped,
      "B + this season": fitWeeklyByPosition([...past, ...before]),
      "C + this season x3": fitWeeklyByPosition([
        ...past, ...Array.from({ length: RECENT_WEIGHT }, () => before).flat(),
      ]),
    };
    // the same players for every fit: those the shipped line calls relevant
    const scored = now.filter((e) => e.week === week &&
      predictWeeklyByPosition(shipped, e) >= RELEVANT);

    for (const variant of VARIANTS) {
      for (const e of scored) {
        const row = {
          week, position: e.position,
          predicted: predictWeeklyByPosition(fits[variant], e), actual: e.target,
        };

        bySeason.get(variant)!.push(row);
        pooled.get(variant)!.push(row);
      }
    }
  }

  report(`${season}, weeks ${weeks[0]}–${weeks[weeks.length - 1]}`, bySeason);
}

if (EVAL_SEASONS.length > 1) {
  report("all seasons", pooled);
}

function report(title: string, scores: Map<Variant, Scored[]>) {
  const n = scores.get("A shipped")!.length;

  console.log(`\n${title}: ${n} player weeks`);
  console.log("variant                 pairs    mae     bias");

  for (const variant of VARIANTS) {
    const rows = scores.get(variant)!;
    const tally = emptyTally();
    const groups = new Map<string, Scored[]>();

    for (const row of rows) {
      const key = `${row.week}|${row.position}`;

      groups.set(key, [...(groups.get(key) ?? []), row]);
    }

    for (const group of groups.values()) {
      addPairs(tally, group.map((r) => ({ predicted: r.predicted, actual: r.actual })));
    }

    const mae = rows.reduce((sum, r) => sum + Math.abs(r.predicted - r.actual), 0) / rows.length;
    const bias = rows.reduce((sum, r) => sum + r.predicted - r.actual, 0) / rows.length;

    console.log(`${variant.padEnd(22)} ${(pairRate(tally, "all") * 100).toFixed(2).padStart(6)}%` +
      `  ${mae.toFixed(3)}  ${bias >= 0 ? "+" : ""}${bias.toFixed(3)}`);
  }
}
