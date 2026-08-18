/**
 * Do sides differ in how fast they play, and does it last?
 *
 * The model works out how many drives a game has from how long the
 * plays take, and it gives every side the league's seconds. It gets
 * the right average number of possessions and orders which sides get
 * more of them at -.028, which is nothing.
 *
 * If tempo is a side's own and it carries from one season to the next,
 * that is the missing term. A coordinator's no-huddle rate follows him
 * to a new club at .44, so there is reason to think it might.
 *
 * Run: npx tsx scripts/paceEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { spearman } from "../src/backtest/metrics.js";
import { timeBetween } from "../src/features/fitPlayClock.js";
import type { Call } from "../src/model/playFactors.js";

const noise = (n: number) => 1 / Math.sqrt(Math.max(2, n - 1));

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

async function main(): Promise<void> {
  const rows = timeBetween(
    parseCsv(await readFile(
      join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
    )).map((r) => ({
      season: Number(r["season"]), week: Number(r["week"]),
      offence: r["offense"] ?? "",
      secondsLeft: Number(r["seconds"]) || 0,
      call: (r["playType"] ?? "") as Call,
      yards: Number(r["yards"]) || 0,
    })),
  );

  /**
   * A side's seconds a snap, with what happened held still.
   *
   * A side that throws more has more plays that stop the clock, so
   * comparing raw seconds a snap would call it fast when it is only
   * incomplete. Each play is measured against what that kind of play
   * takes across the league, and the side's number is how far off it
   * runs.
   */
  const leagueOn = new Map<string, { plays: number; seconds: number }>();
  const kindOf = (r: { call: Call; yards: number }) =>
    r.call === "pass" && r.yards <= 0 ? "incomplete" : r.call;

  for (const row of rows) {
    if (row.took === undefined) {
      continue;
    }

    const own = leagueOn.get(kindOf(row)) ?? { plays: 0, seconds: 0 };
    own.plays++;
    own.seconds += row.took;
    leagueOn.set(kindOf(row), own);
  }

  const bySide = new Map<string, { plays: number; over: number }>();
  const raw = new Map<string, { plays: number; seconds: number }>();

  for (const row of rows) {
    if (row.took === undefined) {
      continue;
    }

    const league = leagueOn.get(kindOf(row))!;
    const usual = league.seconds / league.plays;
    const key = `${row.offence}|${row.season}`;
    const own = bySide.get(key) ?? { plays: 0, over: 0 };
    own.plays++;
    own.over += row.took - usual;
    bySide.set(key, own);

    const flat = raw.get(key) ?? { plays: 0, seconds: 0 };
    flat.plays++;
    flat.seconds += row.took;
    raw.set(key, flat);
  }

  const paces = [...bySide.entries()]
    .filter(([, one]) => one.plays >= 300)
    .map(([key, one]) => ({ key, per: one.over / one.plays }));
  const sorted = [...paces].map((p) => p.per).sort((a, b) => a - b);

  console.log(`${paces.length} side seasons with enough plays\n`);
  console.log(
    "how far a side runs from the league's seconds a snap, " +
      "with what happened held still\n" +
      `  a tenth quicker than ${sorted[Math.floor(sorted.length * 0.1)]!.toFixed(2)}, ` +
      `a tenth slower than ${sorted[Math.floor(sorted.length * 0.9)]!.toFixed(2)}, ` +
      `spread ${Math.sqrt(middle(sorted.map((v) => v * v))).toFixed(2)} seconds`,
  );

  // over a drive of six plays and a game of eleven drives, what that
  // is worth in possessions
  const quick = sorted[Math.floor(sorted.length * 0.1)]!;
  const slow = sorted[Math.floor(sorted.length * 0.9)]!;
  console.log(
    `  which over 5.9 plays a drive is ${((slow - quick) * 5.9).toFixed(0)} ` +
      "seconds a drive between the quickest and the slowest,\n" +
      `  or about ${(3600 / 164 - 3600 / (164 + (slow - quick) * 5.9)).toFixed(1)} ` +
      "possessions a game",
  );

  // and whether it lasts
  const own = new Map<string, Map<number, number>>();

  for (const one of paces) {
    const [team, season] = one.key.split("|");
    const his = own.get(team!) ?? new Map<number, number>();
    his.set(Number(season), one.per);
    own.set(team!, his);
  }

  const was: number[] = [];
  const now: number[] = [];

  for (const his of own.values()) {
    for (const [season, before] of his) {
      const after = his.get(season + 1);

      if (after === undefined) {
        continue;
      }

      was.push(before);
      now.push(after);
    }
  }

  console.log(
    `\nfrom one season to the next, ${was.length} side seasons\n` +
      `  ${spearman(was, now).toFixed(4)}, give or take ${noise(was.length).toFixed(3)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
