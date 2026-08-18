/**
 * Does a coordinator's call sheet travel with him?
 *
 * Every test of a coordinator so far asked about yards, which is what
 * the players do. His own job is choosing what to call, so ask about
 * that instead: how often he runs inside, how often he throws deep,
 * how much he uses the shotgun.
 *
 * Two questions. Does his mix stay the same from one season to the
 * next, and does it come with him when he changes club, which is the
 * test his yards failed.
 *
 * Run: npx tsx scripts/coordinatorConceptEval.ts
 */

import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { splitLine } from "../src/data/csv.js";
import { RAW_DIR } from "../src/data/nflverse.js";
import { spearman } from "../src/backtest/metrics.js";
import { loadCoaches } from "../src/data/coaches.js";

const SEASONS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
const noise = (n: number) => 1 / Math.sqrt(Math.max(2, n - 1));

/** what a side chose to do, counted over a season */
interface Calls {
  plays: number;
  runs: number;
  insideRuns: number;
  runsPlaced: number;
  throws: number;
  deepThrows: number;
  airYards: number;
  thrownPlaced: number;
  shotgun: number;
  noHuddle: number;
}

const empty = (): Calls => ({
  plays: 0, runs: 0, insideRuns: 0, runsPlaced: 0, throws: 0,
  deepThrows: 0, airYards: 0, thrownPlaced: 0, shotgun: 0, noHuddle: 0,
});

const CONCEPTS: [string, (c: Calls) => number | undefined][] = [
  ["how often he runs", (c) => c.plays > 50 ? c.runs / c.plays : undefined],
  ["how often a run goes inside", (c) =>
    c.runsPlaced > 40 ? c.insideRuns / c.runsPlaced : undefined],
  ["how far downfield he throws", (c) =>
    c.thrownPlaced > 50 ? c.airYards / c.thrownPlaced : undefined],
  ["how often a throw goes deep", (c) =>
    c.thrownPlaced > 50 ? c.deepThrows / c.thrownPlaced : undefined],
  ["how often he is in the shotgun", (c) =>
    c.plays > 50 ? c.shotgun / c.plays : undefined],
  ["how often he skips the huddle", (c) =>
    c.plays > 50 ? c.noHuddle / c.plays : undefined],
];

async function main(): Promise<void> {
  const coaches = await loadCoaches();
  const byTeamSeason = new Map<string, Calls>();

  for (const season of SEASONS) {
    const path = join(RAW_DIR, `play_by_play_${season}.csv`);

    if (!existsSync(path)) {
      continue;
    }

    const reader = createInterface({ input: createReadStream(path) });
    let header: string[] | undefined;
    const at: Record<string, number> = {};

    for await (const line of reader) {
      if (!header) {
        header = splitLine(line);
        header.forEach((name, i) => { at[name] = i; });
        continue;
      }

      const c = splitLine(line);
      const type = c[at["play_type"]!] ?? "";

      if (!["run", "pass"].includes(type)) {
        continue;
      }

      const team = c[at["posteam"]!] ?? "";

      if (!team) {
        continue;
      }

      const own = byTeamSeason.get(`${team}|${season}`) ?? empty();
      own.plays++;
      if (c[at["shotgun"]!] === "1") own.shotgun++;
      if (c[at["no_huddle"]!] === "1") own.noHuddle++;

      if (type === "run") {
        own.runs++;
        const gap = c[at["run_gap"]!] ?? "";
        const where = c[at["run_location"]!] ?? "";

        if (gap || where === "middle") {
          own.runsPlaced++;
          // between the tackles counts as inside, round the end as out
          if (where === "middle" || gap === "guard") own.insideRuns++;
        }
      } else {
        own.throws++;
        const air = Number(c[at["air_yards"]!]);

        if (Number.isFinite(air)) {
          own.thrownPlaced++;
          own.airYards += air;
          if (air >= 15) own.deepThrows++;
        }
      }

      byTeamSeason.set(`${team}|${season}`, own);
    }
  }

  console.log(`${byTeamSeason.size} team seasons of play calling\n`);

  const named = (team: string, season: number) =>
    coaches.get(`${team}|${season}|OC`) ?? "";

  interface Pair {
    was: Calls;
    now: Calls;
    sameTeam: boolean;
  }

  const kept: Pair[] = [];
  const moved: Pair[] = [];
  const teamKept: Pair[] = [];

  for (const [key, was] of byTeamSeason) {
    const [team, seasonText] = key.split("|");
    const season = Number(seasonText);
    const who = named(team!, season);

    if (!who) {
      continue;
    }

    // the same coordinator, wherever he turns up next
    for (const [otherKey, now] of byTeamSeason) {
      const [otherTeam, otherText] = otherKey.split("|");

      if (Number(otherText) !== season + 1 || named(otherTeam!, season + 1) !== who) {
        continue;
      }

      const pair = { was, now, sameTeam: otherTeam === team };
      (pair.sameTeam ? kept : moved).push(pair);
    }

    // and the side keeping its habits after he leaves, as the control
    const after = byTeamSeason.get(`${team}|${season + 1}`);

    if (after && named(team!, season + 1) && named(team!, season + 1) !== who) {
      teamKept.push({ was, now: after, sameTeam: true });
    }
  }

  console.log(
    `${kept.length} where he stayed put, ${moved.length} where he moved club, ` +
      `${teamKept.length} where the side replaced him\n`,
  );
  console.log(
    "does the call sheet carry, as rank correlation, more is better\n",
  );
  console.log(
    "  what he chooses                        he stayed   he moved club" +
      "   the side without him",
  );

  for (const [label, of] of CONCEPTS) {
    const scored = (pairs: Pair[]) => {
      const said: number[] = [];
      const truth: number[] = [];

      for (const pair of pairs) {
        const before = of(pair.was);
        const after = of(pair.now);

        if (before === undefined || after === undefined) {
          continue;
        }

        said.push(before);
        truth.push(after);
      }

      return said.length >= 8
        ? `${spearman(said, truth).toFixed(3)} (${said.length})`
        : `few (${said.length})`;
    };

    console.log(
      "  " + label.padEnd(38) + scored(kept).padStart(12) +
        scored(moved).padStart(16) + scored(teamKept).padStart(23),
    );
  }

  console.log(
    "\n  give or take about " +
      noise(Math.max(8, moved.length)).toFixed(3) +
      " on the men who moved club",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
