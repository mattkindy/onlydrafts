/**
 * Is a man's share of the work forecastable, as against his touch count?
 *
 * Touches are his share of the offence times however many plays it ran.
 * Predicting the count from his own past came out at nothing, which
 * would be the same answer whether his share is steady and the volume
 * swings, or his share is the thing nobody can pin down. Those want
 * telling apart.
 *
 * Run: npx tsx scripts/shareForecastEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { spearman } from "../src/backtest/metrics.js";
import { loadPlayerStats } from "../src/data/nflverse.js";

const SCORE_ON = 2025;

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

const spreadOf = (values: number[]) => {
  const mid = middle(values);
  return Math.sqrt(middle(values.map((v) => (v - mid) ** 2)));
};

interface Week {
  week: number;
  touches: number;
  teamPlays: number;
  share: number;
}

async function main(): Promise<void> {
  // how many plays each offence ran each week
  const plays = new Map<string, number>();

  for (const row of parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "plays.csv"), "utf8",
  ))) {
    if (Number(row["season"]) !== SCORE_ON) continue;
    if (!["run", "pass"].includes(row["playType"] ?? "")) continue;
    const key = `${row["week"]}|${row["offense"]}`;
    plays.set(key, (plays.get(key) ?? 0) + 1);
  }

  const byPlayer = new Map<string, Week[]>();

  for (const s of await loadPlayerStats(SCORE_ON)) {
    if (s.week > 18 || !["RB", "WR", "TE"].includes(s.position)) continue;
    const teamPlays = plays.get(`${s.week}|${s.teamId}`);
    if (!teamPlays) continue;
    const touches = s.carries + s.targets;
    byPlayer.set(s.playerId, [...(byPlayer.get(s.playerId) ?? []), {
      week: s.week, touches, teamPlays, share: touches / teamPlays,
    }]);
  }

  const players = [...byPlayer.values()]
    .filter((weeks) => weeks.length >= 8 && middle(weeks.map((w) => w.touches)) >= 3)
    .map((weeks) => [...weeks].sort((a, b) => a.week - b.week));
  console.log(`${players.length} men with eight weeks and three touches a game\n`);

  // how much each part wobbles, as a share of its own average
  const wobble = (of: (w: Week) => number) => {
    const relative: number[] = [];

    for (const own of players) {
      const mid = middle(own.map(of));
      if (mid <= 0) continue;
      for (const week of own) relative.push(of(week) / mid);
    }

    return spreadOf(relative);
  };

  console.log("week to week, as a fraction of a man's own average");
  console.log(`  his touch count wobbles   ${wobble((w) => w.touches).toFixed(3)}`);
  console.log(`  his share wobbles         ${wobble((w) => w.share).toFixed(3)}`);
  console.log(`  his team's plays wobble   ${wobble((w) => w.teamPlays).toFixed(3)}`);

  /**
   * Whether last week's news carries to this one, asked of a man
   * against his own season average so a steady player scores nothing
   * for being steady.
   */
  const staysWith = (of: (w: Week) => number, look: number) => {
    const said: number[] = [];
    const was: number[] = [];

    for (const own of players) {
      for (const week of own) {
        const before = own.filter((w) => w.week < week.week).slice(-look);

        if (before.length < look) {
          continue;
        }

        // his average with this week left out of it. Counting a week
        // inside its own baseline pushes the answer down by about one
        // over the number of weeks, which is enough on a ten game
        // season to turn a small positive into a negative.
        const others = own.filter((w) => w.week !== week.week);
        const mid = middle(others.map(of));
        said.push(middle(before.map(of)) - mid);
        was.push(of(week) - mid);
      }
    }

    return { rank: spearman(said, was), n: said.length };
  };

  console.log("\ndoes the recent past say where he is now, against his own average");
  console.log("  looking back      touch count     share      team plays");

  for (const look of [1, 3, 5]) {
    const touches = staysWith((w) => w.touches, look);
    const share = staysWith((w) => w.share, look);
    const volume = staysWith((w) => w.teamPlays, look);
    console.log(
      `  ${String(look).padEnd(18)}` +
      touches.rank.toFixed(4).padStart(7) +
      share.rank.toFixed(4).padStart(12) +
      volume.rank.toFixed(4).padStart(14) +
      `      (${share.n} weeks)`,
    );
  }

  // and the same question across players, which is the easy one
  const across = (of: (w: Week) => number) => {
    const said: number[] = [];
    const was: number[] = [];

    for (const own of players) {
      const half = Math.floor(own.length / 2);
      said.push(middle(own.slice(0, half).map(of)));
      was.push(middle(own.slice(half).map(of)));
    }

    return spearman(said, was);
  };

  console.log(
    "\nacross players, first half of his season against his second" +
    `\n  touch count  ${across((w) => w.touches).toFixed(4)}` +
    `\n  share        ${across((w) => w.share).toFixed(4)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
