/**
 * Is the walk's floor and ceiling better than the one we ship?
 *
 * The slate takes floor and ceiling from pooled residual quantiles, so
 * two men projected the same get the same band whatever their week
 * looks like. The walk plays each man's week forty times and has a band
 * of his own. This scores both against what was really scored, on the
 * weeks the walk cache covers, and checks the boom and bust chances the
 * walk states against how often those finishes happened.
 *
 * Run: npx tsx scripts/weeklyBandEval.ts [seasons, comma separated]
 */

import { loadGames } from "../src/data/nflverse.js";
import { presets } from "../src/scoring/fantasyPoints.js";
import {
  weeklyExamplesForSeason,
} from "../src/features/weeklyModel.js";
import {
  fitWeeklyByPosition, predictWeeklyByPosition,
} from "../src/features/fitWeeklyByPosition.js";
import { buildResidualModel, outcomeQuantile } from "../src/backtest/intervals.js";
import { loadWalkWeekly, walkKey } from "../src/features/walkWeeklyCache.js";
import { spreadOf } from "../src/features/runSpread.js";
import { bandFor } from "../src/features/weeklyBand.js";
import { linesFor, chancesFrom } from "../src/features/weeklyLines.js";

const SEASONS = (process.argv[2] ?? "2024,2025").split(",").map(Number);
const POSITIONS = ["QB", "RB", "WR", "TE"];
const RULES = presets.ppr;
/** below this a man is not being started, so his band is not read */
const STARTABLE = 6;

interface Scored {
  floor: number;
  ceiling: number;
  was: number;
}

function pinball(guess: number, was: number, q: number): number {
  return was >= guess ? (was - guess) * q : (guess - was) * (1 - q);
}

function score(name: string, rows: Scored[]): string {
  const inside = rows.filter((r) => r.was >= r.floor && r.was <= r.ceiling).length;
  const width = rows.reduce((s, r) => s + (r.ceiling - r.floor), 0) / rows.length;
  const loss = rows.reduce(
    (s, r) => s + pinball(r.floor, r.was, 0.1) + pinball(r.ceiling, r.was, 0.9),
    0,
  ) / rows.length / 2;

  return `${name.padEnd(16)} ${(100 * inside / rows.length).toFixed(1).padStart(5)}% ` +
    `${width.toFixed(1).padStart(6)}  ${loss.toFixed(3).padStart(6)}`;
}

const games = await loadGames();
const walked = await loadWalkWeekly();

if (walked.size === 0) {
  throw new Error("no walk cache; run scripts/walkWeekCache.ts first");
}

for (const season of SEASONS) {
  const train = [];

  for (let s = 2016; s < season; s++) {
    train.push(...(await weeklyExamplesForSeason(s, games)));
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
  const lines = await linesFor(
    [season - 3, season - 2, season - 1], RULES,
  );

  const all = new Map<string, Scored[]>();
  const startable = new Map<string, Scored[]>();
  const chances: {
    boomSaid: number; boomWas: boolean;
    bustSaid: number; bustWas: boolean;
  }[] = [];

  const keep = (which: Map<string, Scored[]>, name: string, row: Scored) => {
    which.set(name, [...(which.get(name) ?? []), row]);
  };

  for (const e of await weeklyExamplesForSeason(season, games)) {
    const row = walked.get(walkKey(season, e.week, e.playerId));

    if (!row || row.dealt.length === 0 || !POSITIONS.includes(e.position)) {
      continue;
    }

    const centre = predictWeeklyByPosition(weekly, e);
    const pooled = {
      floor: Math.max(0, outcomeQuantile(residuals, e.position, centre, 0.1)),
      ceiling: Math.max(0, outcomeQuantile(residuals, e.position, centre, 0.9)),
    };
    const walk = spreadOf(row.dealt);
    const stretched = bandFor(walk, pooled);
    const raw = bandFor(walk, pooled, 1);
    const blend = {
      floor: (pooled.floor + stretched.floor) / 2,
      ceiling: (pooled.ceiling + stretched.ceiling) / 2,
    };
    const each: [string, { floor: number; ceiling: number }][] = [
      ["pooled", pooled],
      ["walk", raw],
      ["walk x1.2", stretched],
      ["blend", blend],
    ];

    for (const [name, band] of each) {
      keep(all, name, { ...band, was: e.target });

      if (centre >= STARTABLE) {
        keep(startable, name, { ...band, was: e.target });
      }
    }

    const said = chancesFrom(row.dealt, lines, e.position);

    if (said && centre >= STARTABLE) {
      chances.push({
        boomSaid: said.boomChance,
        boomWas: e.target >= lines.boom[e.position]!,
        bustSaid: said.bustChance,
        bustWas: e.target <= lines.bust[e.position]!,
      });
    }
  }

  console.log(`\n=== ${season} ===`);
  console.log(
    "boom line " +
      POSITIONS.map((p) => `${p} ${lines.boom[p]!.toFixed(1)}`).join(", ") +
      "; bust line " +
      POSITIONS.map((p) => `${p} ${lines.bust[p]!.toFixed(1)}`).join(", "),
  );

  for (const [what, rows] of [["every man", all], ["startable", startable]] as const) {
    const first = [...rows.values()][0] ?? [];
    console.log(
      `\n${what}, ${first.length} man weeks` +
        "\n                 inside   width    loss",
    );

    for (const [name, scored] of rows) {
      console.log(score(name, scored));
    }
  }

  console.log(`\nchances on ${chances.length} startable man weeks`);

  for (const [which, said, was] of [
    ["boom", (c: typeof chances[number]) => c.boomSaid, (c: typeof chances[number]) => c.boomWas],
    ["bust", (c: typeof chances[number]) => c.bustSaid, (c: typeof chances[number]) => c.bustWas],
  ] as const) {
    const buckets = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.7, 1.01];
    const parts: string[] = [];

    for (let i = 0; i < buckets.length - 1; i++) {
      const inside = chances.filter(
        (c) => said(c) >= buckets[i]! && said(c) < buckets[i + 1]!,
      );

      if (inside.length === 0) {
        continue;
      }

      const stated = inside.reduce((s, c) => s + said(c), 0) / inside.length;
      const happened = inside.filter((c) => was(c)).length / inside.length;
      parts.push(
        `said ${(100 * stated).toFixed(0)}% was ${(100 * happened).toFixed(0)}% ` +
          `(n=${inside.length})`,
      );
    }

    const stated = chances.reduce((s, c) => s + said(c), 0) / chances.length;
    const happened = chances.filter((c) => was(c)).length / chances.length;
    console.log(
      `${which}: overall said ${(100 * stated).toFixed(1)}% ` +
        `was ${(100 * happened).toFixed(1)}%\n  ${parts.join("\n  ")}`,
    );
  }
}
