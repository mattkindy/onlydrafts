/**
 * Whether a man's long plays are a thing about him.
 *
 * The walk scales a player by what he averages a touch, so a possession
 * receiver and a deep threat who both make eleven yards a catch draw
 * from the same shape. If how often a man breaks a long one is his own
 * and lasts from season to season, that is missing, and long scores are
 * where it would show.
 *
 * Run: npx tsx scripts/deepThreatEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { spearman } from "../src/backtest/metrics.js";
import { loadPlayerStats } from "../src/data/nflverse.js";

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

const noise = (n: number) => 1 / Math.sqrt(Math.max(2, n - 1));

interface Own {
  touches: number;
  yards: number;
  long: number;
  veryLong: number;
}

async function seasonOf(season: number): Promise<Map<string, Own>> {
  const rows = parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "touches.csv"), "utf8",
  )).filter((r) => Number(r["season"]) === season && r["player"]);
  const tally = new Map<string, Own>();

  for (const row of rows) {
    const own = tally.get(row["player"]!) ??
      { touches: 0, yards: 0, long: 0, veryLong: 0 };
    const gained = Number(row["yards"]) || 0;
    own.touches++;
    own.yards += gained;
    if (gained >= 20) own.long++;
    if (gained >= 40) own.veryLong++;
    tally.set(row["player"]!, own);
  }

  return tally;
}

async function main(): Promise<void> {
  const before = await seasonOf(2024);
  const now = await seasonOf(2025);
  const position = new Map<string, string>();

  for (const s of await loadPlayerStats(2025)) {
    position.set(s.playerId, s.position);
  }

  const both = [...now].filter(([player, own]) =>
    own.touches >= 40 && (before.get(player)?.touches ?? 0) >= 40 &&
    ["RB", "WR", "TE"].includes(position.get(player) ?? ""));
  console.log(`${both.length} men with forty touches in both seasons\n`);

  const was = (player: string) => before.get(player)!;
  const rate = (own: Own) => own.long / own.touches;
  const perTouch = (own: Own) => own.yards / own.touches;

  console.log("carried from one season to the next   spearman");
  console.log(
    "  his yards a touch                   " +
      spearman(
        both.map(([p]) => perTouch(was(p))), both.map(([, own]) => perTouch(own)),
      ).toFixed(4) +
      "\n  how often he breaks a twenty        " +
      spearman(
        both.map(([p]) => rate(was(p))), both.map(([, own]) => rate(own)),
      ).toFixed(4) +
      "\n  how often he breaks a forty         " +
      spearman(
        both.map(([p]) => was(p).veryLong / was(p).touches),
        both.map(([, own]) => own.veryLong / own.touches),
      ).toFixed(4) +
      `\n  give or take ${noise(both.length).toFixed(3)}`,
  );

  /**
   * And whether it says anything his average does not. A man who breaks
   * long ones will average more for it, so the question is what is left
   * once his average is taken out.
   */
  const middleRate = middle(both.map(([, own]) => rate(own)));
  const middlePer = middle(both.map(([, own]) => perTouch(own)));
  const extraBefore = both.map(([p]) =>
    rate(was(p)) - middleRate * (perTouch(was(p)) / middlePer));
  const extraNow = both.map(([, own]) =>
    rate(own) - middleRate * (perTouch(own) / middlePer));

  console.log(
    "\n  his long plays beyond what his average implies, carried: " +
      spearman(extraBefore, extraNow).toFixed(4),
  );

  // what the spread of it looks like, so its size is clear
  const rates = both.map(([, own]) => rate(own)).sort((a, b) => a - b);
  console.log(
    `\n  breaking a twenty runs from ${(100 * rates[Math.floor(rates.length * 0.1)]!)
      .toFixed(1)}% of touches at the tenth ` +
      `to ${(100 * rates[Math.floor(rates.length * 0.9)]!).toFixed(1)}% at the ninetieth`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
