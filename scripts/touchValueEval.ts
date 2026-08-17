/**
 * Valuing a touch by the state it came from, against the four buckets.
 *
 * A man's projected points are how many touches he gets times what a
 * touch is worth. The buckets give every touch inside the twenty the
 * same worth, when the two yard line scores six times as often as the
 * eighteen. This asks whether keeping the state is worth anything once
 * it reaches a season projection.
 *
 * Run: npx tsx scripts/touchValueEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { spearman } from "../src/backtest/metrics.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { fitTouchValue, type TouchRow } from "../src/features/touchValue.js";

const RULES = presets.standard;
const SCORE_ON = Number(process.env["SEASON"] ?? 2025);

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

interface Touch {
  season: number;
  player: string;
  down: number;
  toGo: number;
  yardline: number;
  type: string;
  yards: number;
  touchdown: number;
}

async function main(): Promise<void> {
  const all = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
  )).map((r) => ({
    season: Number(r["season"]), player: r["player"] ?? "",
    down: Number(r["down"]), toGo: Number(r["togo"]),
    yardline: Number(r["yardline"]), type: r["playType"] ?? "",
    yards: Number(r["yards"]) || 0, touchdown: Number(r["touchdown"]) || 0,
  })) as Touch[];

  // fitted on the seasons before the one being guessed at
  const learn = all.filter((t) => t.season < SCORE_ON);
  const value = fitTouchValue(learn as TouchRow[]);
  console.log(`${learn.length} touches to learn what one is worth\n`);

  // and the bucketed version, the way the model does it now
  const bucketOf = (t: Touch) => {
    if (t.yardline <= 20) return "nearGoal";
    if (t.down === 3 && t.toGo <= 2) return "thirdAndShort";
    if (t.down === 3) return "thirdAndLong";
    return "openField";
  };
  const buckets = new Map<string, { plays: number; yards: number; scores: number }>();

  for (const t of learn) {
    const at = `${t.type}|${bucketOf(t)}`;
    const cell = buckets.get(at) ?? { plays: 0, yards: 0, scores: 0 };
    cell.plays++;
    cell.yards += t.yards;
    cell.scores += t.touchdown;
    buckets.set(at, cell);
  }

  const bucketPoints = (t: Touch) => {
    const cell = buckets.get(`${t.type}|${bucketOf(t)}`);
    if (!cell || !cell.plays) return 0.4;
    return (cell.yards / cell.plays) * RULES.rushYds +
      (cell.scores / cell.plays) * RULES.rushTd;
  };

  // Each man's touches last season, valued both ways. His workload is
  // held identical between them, so the only thing being compared is
  // what a touch is said to be worth.
  const before = all.filter((t) => t.season === SCORE_ON - 1);
  const byPlayer = new Map<string, Touch[]>();

  for (const t of before) {
    byPlayer.set(t.player, [...(byPlayer.get(t.player) ?? []), t]);
  }

  const scored = new Map<string, number>();

  for (const s of await loadPlayerStats(SCORE_ON)) {
    if (s.week > 18 || !["RB", "WR", "TE"].includes(s.position)) continue;
    scored.set(
      s.playerId, (scored.get(s.playerId) ?? 0) + fantasyPoints(s.statLine, RULES),
    );
  }

  const men = [...byPlayer].filter(([player, touches]) =>
    scored.has(player) && touches.length >= 20);
  console.log(`${men.length} men with twenty touches or more the season before\n`);

  const truth = men.map(([player]) => scored.get(player)!);

  console.log("ranking this season's points   spearman");

  for (const [label, of] of [
    ["how many touches he had", (t: Touch[]) => t.length],
    ["valued by the four buckets", (t: Touch[]) =>
      t.reduce((a, x) => a + bucketPoints(x), 0)],
    ["valued by where they came from", (t: Touch[]) =>
      t.reduce((a, x) => a + value.points(
        { down: x.down, toGo: x.toGo, yardline: x.yardline, type: x.type as "run" | "pass" },
        RULES.rushYds, RULES.rushTd,
      ), 0)],
  ] as [string, (t: Touch[]) => number][]) {
    console.log(
      "  " + label.padEnd(34) +
      spearman(men.map(([, t]) => of(t)), truth).toFixed(4).padStart(7),
    );
  }

  // what the two say about the same men, where they disagree most
  const rows = men.map(([player, touches]) => ({
    player,
    bucketed: touches.reduce((a, x) => a + bucketPoints(x), 0),
    stated: touches.reduce((a, x) => a + value.points(
      { down: x.down, toGo: x.toGo, yardline: x.yardline, type: x.type as "run" | "pass" },
      RULES.rushYds, RULES.rushTd,
    ), 0),
    touches: touches.length,
  }));
  const gap = rows.map((r) => r.stated - r.bucketed);
  console.log(
    `\n  the two differ by ${middle(gap.map(Math.abs)).toFixed(1)} points a man ` +
      `on average, and by ${Math.max(...gap.map(Math.abs)).toFixed(1)} at most`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
