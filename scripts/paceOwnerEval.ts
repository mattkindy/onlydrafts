/**
 * Whose tempo is it?
 *
 * A side's seconds a snap carries to the next season at .507, which is
 * worth two possessions a game. A coordinator's no-huddle rate follows
 * him to a new club at .44, so the tempo may be his rather than the
 * club's. If it is, a side with a new coordinator should be given his
 * pace and not last year's.
 *
 * Run: npx tsx scripts/paceOwnerEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { spearman } from "../src/backtest/metrics.js";
import { loadCoaches } from "../src/data/coaches.js";
import { timeBetween } from "../src/features/fitPlayClock.js";
import type { Call } from "../src/model/playFactors.js";

const noise = (n: number) => 1 / Math.sqrt(Math.max(2, n - 1));

async function main(): Promise<void> {
  const coaches = await loadCoaches();
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

  // what each kind of play takes across the league, so a side that
  // throws a lot is not called quick for being incomplete
  const kindOf = (r: { call: Call; yards: number }) =>
    r.call === "pass" && r.yards <= 0 ? "incomplete" : r.call;
  const leagueOn = new Map<string, { plays: number; seconds: number }>();

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

  for (const row of rows) {
    if (row.took === undefined) {
      continue;
    }

    const league = leagueOn.get(kindOf(row))!;
    const key = `${row.offence}|${row.season}`;
    const own = bySide.get(key) ?? { plays: 0, over: 0 };
    own.plays++;
    own.over += row.took - league.seconds / league.plays;
    bySide.set(key, own);
  }

  const paceOf = new Map<string, number>();

  for (const [key, one] of bySide) {
    if (one.plays >= 300) {
      paceOf.set(key, one.over / one.plays);
    }
  }

  const who = (team: string, season: number, role: string) =>
    coaches.get(`${team}|${season}|${role}`) ?? "";

  interface Pair {
    was: number;
    now: number;
    sameOc: boolean;
    sameHc: boolean;
  }

  const pairs: Pair[] = [];
  /** and the same coordinator turning up somewhere else */
  const followed: { was: number; now: number }[] = [];

  for (const [key, was] of paceOf) {
    const [team, seasonText] = key.split("|");
    const season = Number(seasonText);
    const next = paceOf.get(`${team}|${season + 1}`);
    const oc = who(team!, season, "OC");

    if (next !== undefined && oc && who(team!, season + 1, "OC")) {
      pairs.push({
        was, now: next,
        sameOc: oc === who(team!, season + 1, "OC"),
        sameHc: who(team!, season, "HC") === who(team!, season + 1, "HC"),
      });
    }

    // wherever that coordinator turns up the following season
    if (!oc) {
      continue;
    }

    for (const [otherKey, other] of paceOf) {
      const [otherTeam, otherText] = otherKey.split("|");

      if (
        Number(otherText) !== season + 1 || otherTeam === team ||
        who(otherTeam!, season + 1, "OC") !== oc
      ) {
        continue;
      }

      followed.push({ was, now: other });
    }
  }

  console.log(`${pairs.length} side seasons back to back\n`);
  console.log("does a side's tempo carry?   n   carries over   give or take");

  for (const [label, is] of [
    ["it kept both of them", (p: Pair) => p.sameOc && p.sameHc],
    ["a new coordinator", (p: Pair) => !p.sameOc],
    ["a new head coach", (p: Pair) => !p.sameHc],
  ] as [string, (p: Pair) => boolean][]) {
    const these = pairs.filter(is);

    if (these.length < 8) {
      console.log("  " + label.padEnd(26) + String(these.length).padStart(4) +
        "   too few to say");
      continue;
    }

    console.log(
      "  " + label.padEnd(26) + String(these.length).padStart(4) +
        spearman(these.map((p) => p.was), these.map((p) => p.now))
          .toFixed(3).padStart(15) +
        noise(these.length).toFixed(3).padStart(15),
    );
  }

  console.log(
    `\nand a coordinator who moved club, ${followed.length} of them\n` +
      (followed.length >= 8
        ? `  his old side's tempo says his new one at ` +
          spearman(followed.map((f) => f.was), followed.map((f) => f.now)).toFixed(3) +
          `, give or take ${noise(followed.length).toFixed(3)}`
        : "  too few to say"),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
