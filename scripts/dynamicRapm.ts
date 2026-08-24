/**
 * Runs the week-by-week filter over the real snaps, then asks a
 * question nothing in the model was told the answer to: when a man
 * misses a stretch and comes back, is he the player he was?
 *
 * Run: npx tsx scripts/dynamicRapm.ts
 */

import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { RAW_DIR } from "../src/data/nflverse.js";
import type { Snap } from "../src/model/plusMinus.js";
import {
  advance, emptyState, observe, type DynamicState,
} from "../src/model/dynamicPlusMinus.js";
import { splitLine } from "../src/data/csv.js";

const SEASONS = [2023, 2024, 2025];
const BLOCKERS = new Set(["T", "G", "C", "TE", "QB", "RB", "FB"]);
const RUSHERS = new Set(["DE", "DT", "NT", "OLB", "ILB", "LB", "MLB"]);

async function weeksOf(season: number): Promise<Map<number, Snap[]>> {
  const path = join(RAW_DIR, `participation_${season}.csv`);
  const byWeek = new Map<number, Snap[]>();

  if (!existsSync(path)) {
    return byWeek;
  }

  const reader = createInterface({ input: createReadStream(path) });
  let header: string[] | undefined;
  let iOff = -1, iDef = -1, iOffPos = -1, iDefPos = -1, iPressure = -1, iGame = -1;

  for await (const line of reader) {
    if (!header) {
      header = splitLine(line);
      iOff = header.indexOf("offense_players");
      iDef = header.indexOf("defense_players");
      iOffPos = header.indexOf("offense_positions");
      iDefPos = header.indexOf("defense_positions");
      iPressure = header.indexOf("was_pressure");
      iGame = header.indexOf("nflverse_game_id");
      continue;
    }

    const cells = splitLine(line);
    const pressure = cells[iPressure];
    if (pressure !== "TRUE" && pressure !== "FALSE") continue;

    const offIds = (cells[iOff] ?? "").split(";").filter(Boolean);
    const defIds = (cells[iDef] ?? "").split(";").filter(Boolean);
    const offPos = (cells[iOffPos] ?? "").split(";");
    const defPos = (cells[iDefPos] ?? "").split(";");
    if (offIds.length !== offPos.length || defIds.length !== defPos.length) continue;

    const blockers = offIds.filter((_, i) => BLOCKERS.has(offPos[i]!));
    const rushers = defIds.filter((_, i) => RUSHERS.has(defPos[i]!));
    if (blockers.length < 5 || rushers.length < 3) continue;

    const week = Number((cells[iGame] ?? "").split("_")[1]);
    // the playoffs would otherwise make every non-qualifier look injured
    if (!Number.isFinite(week) || week > 18) continue;

    byWeek.set(week, [
      ...(byWeek.get(week) ?? []),
      { forIt: blockers, against: rushers, outcome: pressure === "TRUE" ? 0 : 1 },
    ]);
  }

  return byWeek;
}

async function main(): Promise<void> {
  let state: DynamicState = emptyState(0.85);
  const track: { season: number; week: number; id: string; mean: number; variance: number }[] = [];
  const appeared = new Map<string, Set<string>>();

  for (const season of SEASONS) {
    const byWeek = await weeksOf(season);
    const weeks = [...byWeek.keys()].sort((a, b) => a - b);
    console.log(`${season}: ${weeks.length} weeks, ${[...byWeek.values()].flat().length} drop-backs`);

    for (const week of weeks) {
      const snaps = byWeek.get(week)!;
      const played = new Set(snaps.flatMap((s) => [...s.forIt, ...s.against]));

      for (const id of played) {
        appeared.set(id, (appeared.get(id) ?? new Set()).add(`${season}|${week}`));
      }

      state = advance(state, played);
      state = observe(state, snaps);

      for (const [id, belief] of state.players) {
        track.push({ season, week, id, mean: belief.mean, variance: belief.variance });
      }
    }
  }

  // find stretches a man missed, after we already knew him well
  const timeline = new Map<string, typeof track>();

  for (const row of track) {
    timeline.set(row.id, [...(timeline.get(row.id) ?? []), row]);
  }

  const returns: { before: number; after: number; missed: number; varBefore: number }[] = [];

  for (const [id, rows] of timeline) {
    const seen = appeared.get(id) ?? new Set();
    const stamps = rows.map((r) => `${r.season}|${r.week}`);

    for (let i = 4; i < rows.length - 4; i++) {
      const outNow = !seen.has(stamps[i]!);
      const playedBefore = seen.has(stamps[i - 1]!);
      if (!outNow || !playedBefore) continue;

      let gap = 0;
      while (i + gap < rows.length && !seen.has(stamps[i + gap]!)) gap++;
      if (gap < 3 || i + gap + 3 >= rows.length) continue;
      // a gap that straddles February is an offseason, not an injury
      if (rows[i - 1]!.season !== rows[i + gap]!.season) continue;

      // did he play enough before the gap for us to know him?
      const before = rows[i - 1]!;
      if (before.variance > 0.0015) continue;
      const after = rows[i + gap + 2]!;
      returns.push({
        before: before.mean, after: after.mean, missed: gap,
        varBefore: before.variance,
      });
      i += gap + 3;
    }
  }

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const change = returns.map((r) => r.after - r.before);

  console.log(`\n${returns.length} returns from three weeks out or more,`);
  console.log("by men we already had a firm read on\n");
  console.log("  average change in his number   " +
    (mean(change) >= 0 ? "+" : "") + mean(change).toFixed(4));
  console.log("  share who came back worse      " +
    ((change.filter((c) => c < 0).length / change.length) * 100).toFixed(1) + "%");

  for (const [label, low, high] of [
    ["3 to 5 weeks out", 3, 5], ["6 to 9 weeks out", 6, 9], ["10 or more", 10, 99],
  ] as [string, number, number][]) {
    const sub = returns.filter((r) => r.missed >= low && r.missed <= high);
    if (sub.length < 10) continue;
    const d = mean(sub.map((r) => r.after - r.before));
    console.log("  " + label.padEnd(30) + (d >= 0 ? "+" : "") + d.toFixed(4) +
      "   (" + sub.length + " cases)");
  }

  console.log("\nnothing in the model was told injuries matter; this is what the snaps said");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
