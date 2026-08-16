/**
 * Loads the football facts and asks, as a query, the question I got
 * wrong by hand this morning: who missed a run of games and came back.
 *
 * The hand-written version counted the playoffs as an injury and found
 * 1796 cases where there were 453. Here "a week that counts" is a fact
 * and "missed" is one rule, so the same mistake has nowhere to live.
 *
 * Run: npx tsx scripts/factsCheck.ts
 */

import {
  Database, constant, evaluate, lit, rule, variable as v,
} from "@suss/datalog";
import { loadWeeklyRosters, loadPlayerStats } from "../src/data/nflverse.js";
import { loadCoaches } from "../src/data/coaches.js";
import { ABSENCE_RULES } from "../src/datalog/football.js";

const SEASONS = [2023, 2024, 2025];
const LAST_COUNTING_WEEK = 18;

async function main(): Promise<void> {
  const db = new Database();
  // Datalog has no built-in inequality, so equality is a fact and the
  // rules negate it. Without these, "not sameName" is true of every
  // pair and every team looks like it hired someone.
  const names = new Set<string>();
  const coaches = await loadCoaches();

  for (const [key, person] of coaches) {
    const [team, season, role] = key.split("|");
    db.add("coached", [team!, Number(season), role!, person]);
    names.add(person);
    names.add(team!);
  }

  for (const season of SEASONS) {
    for (let week = 1; week <= LAST_COUNTING_WEEK; week++) {
      db.add("countingWeek", [season, week]);

      if (week > 1) {
        db.add("previousWeek", [season, week - 1, week]);
      }
    }

    if (season > SEASONS[0]!) {
      db.add("previousSeason", [season, season - 1]);
    }

    for (const row of await loadWeeklyRosters(season)) {
      if (row.week <= LAST_COUNTING_WEEK) {
        db.add("rostered", [row.playerId, row.teamId, season, row.week]);
      }
    }

    for (const row of await loadPlayerStats(season)) {
      if (row.week <= LAST_COUNTING_WEEK) {
        db.add("played", [row.playerId, season, row.week]);
        db.add("position", [row.playerId, season, row.position]);
      }
    }

    console.log(`${season} facts loaded`);
  }

  for (const name of names) {
    db.add("sameName", [name, name]);
  }

  console.log(`${names.size} names, ${db.facts("coached").length} coach facts`);
  console.time("fixpoint");
  evaluate(db, ABSENCE_RULES);
  console.timeEnd("fixpoint");

  console.log("\nderived:");
  for (const name of ["missed", "wentOut", "cameBack"]) {
    console.log("  " + name.padEnd(12) + db.facts(name).length);
  }

  // a run of missed weeks, by asking for the games he went out and came back
  const out = new Map<string, number[]>();

  for (const [p, s, w] of db.facts("wentOut") as [string, number, number][]) {
    out.set(`${p}|${s}`, [...(out.get(`${p}|${s}`) ?? []), w]);
  }

  const back = new Map<string, number[]>();

  for (const [p, s, w] of db.facts("cameBack") as [string, number, number][]) {
    back.set(`${p}|${s}`, [...(back.get(`${p}|${s}`) ?? []), w]);
  }

  const spells: { player: string; season: number; from: number; weeks: number }[] = [];

  for (const [key, starts] of out) {
    const [player, season] = key.split("|");
    const returns = (back.get(key) ?? []).sort((a, b) => a - b);

    for (const start of starts.sort((a, b) => a - b)) {
      const back0 = returns.find((r) => r > start);
      if (back0 === undefined) continue;
      spells.push({ player: player!, season: Number(season), from: start, weeks: back0 - start });
    }
  }

  const long = spells.filter((s) => s.weeks >= 3);
  console.log(`\n${spells.length} spells out of any length`);
  console.log(`${long.length} of three weeks or more, which the hand-written`);
  console.log("version put at 453 for the men it had a firm read on\n");

  const byLength = new Map<number, number>();

  for (const spell of long) {
    const band = spell.weeks >= 10 ? 10 : spell.weeks;
    byLength.set(band, (byLength.get(band) ?? 0) + 1);
  }

  for (const [weeks, count] of [...byLength].sort((a, b) => a[0] - b[0])) {
    console.log("  " + (weeks === 10 ? "10 or more" : weeks + " weeks").padEnd(12) + count);
  }

  // a question I never wrote a script for, now three lines of rule
  evaluate(db, [
    ...ABSENCE_RULES,
    rule("qbMissed", [v("p"), v("s"), v("w")], [
      lit("missed", v("p"), v("s"), v("w")),
      lit("position", v("p"), v("s"), constant("QB")),
    ]),
    rule("backUnderNewVoice", [v("p"), v("s")], [
      lit("cameBack", v("p"), v("s"), v("w")),
      lit("underNewVoice", v("p"), v("s"), v("team")),
    ]),
  ]);

  console.log("\nquestions I never wrote a script for:");
  console.log("  quarterback weeks missed        " + db.facts("qbMissed").length);
  console.log("  returns under a new coordinator " +
    new Set(db.facts("backUnderNewVoice").map((t) => t.join("|"))).size);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
