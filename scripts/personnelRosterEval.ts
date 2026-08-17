/**
 * Is what an offence lines up in a property of the coach, or of the
 * players he has?
 *
 * A coordinator with two tight ends worth playing runs two tight ends.
 * The same man with three receivers worth playing runs three. If that
 * is what is happening then the coach effect never travels on its own,
 * because the roster does not travel with him, and the thing to
 * predict from is the depth chart rather than the name.
 *
 * Run: npx tsx scripts/personnelRosterEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { loadCoaches } from "../src/data/coaches.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { spearman } from "../src/backtest/metrics.js";

const SEASONS = [2022, 2023, 2024, 2025];

interface TeamSeason {
  team: string;
  season: number;
  twelve: number;
  eleven: number;
  /** what the second tight end and the third receiver were worth */
  secondTightEnd: number;
  thirdReceiver: number;
  oc: string;
}

async function main(): Promise<void> {
  const plays = parseCsv(
    await readFile(join(import.meta.dirname, "..", "data", "curated", "plays.csv"), "utf8"),
  ).filter((r) => r["grouping"]);

  const coaches = await loadCoaches();
  const rows: TeamSeason[] = [];

  for (const season of SEASONS) {
    // how good each room's spare parts were, by points a game
    const byPlayer = new Map<string, { team: string; position: string; points: number; games: number }>();

    for (const s of await loadPlayerStats(season)) {
      if (s.week > 18 || !["WR", "TE"].includes(s.position)) continue;
      const own = byPlayer.get(s.playerId) ??
        { team: s.teamId, position: s.position, points: 0, games: 0 };
      own.points += fantasyPoints(s.statLine, presets.standard);
      own.games++;
      byPlayer.set(s.playerId, own);
    }

    const rooms = new Map<string, { tightEnds: number[]; receivers: number[] }>();

    for (const own of byPlayer.values()) {
      if (own.games < 6) continue;
      const room = rooms.get(own.team) ?? { tightEnds: [], receivers: [] };
      const perGame = own.points / own.games;
      if (own.position === "TE") room.tightEnds.push(perGame);
      else room.receivers.push(perGame);
      rooms.set(own.team, room);
    }

    const inSeason = plays.filter((p) => Number(p["season"]) === season);
    const byTeam = new Map<string, { twelve: number; eleven: number; total: number }>();

    for (const play of inSeason) {
      const team = play["offense"] ?? "";
      const counts = byTeam.get(team) ?? { twelve: 0, eleven: 0, total: 0 };
      counts.total++;
      if (play["grouping"] === "12") counts.twelve++;
      if (play["grouping"] === "11") counts.eleven++;
      byTeam.set(team, counts);
    }

    for (const [team, counts] of byTeam) {
      const room = rooms.get(team);
      if (!room || counts.total < 300) continue;
      const tightEnds = [...room.tightEnds].sort((a, b) => b - a);
      const receivers = [...room.receivers].sort((a, b) => b - a);
      if (tightEnds.length < 2 || receivers.length < 3) continue;

      rows.push({
        team, season,
        twelve: counts.twelve / counts.total,
        eleven: counts.eleven / counts.total,
        secondTightEnd: tightEnds[1]!,
        thirdReceiver: receivers[2]!,
        oc: coaches.get(`${team}|${season}|OC`) ?? "",
      });
    }
  }

  console.log(`${rows.length} team-seasons\n`);
  console.log("what goes with how often an offence runs two tight ends\n");
  console.log("  measure                              spearman");

  for (const [label, get] of [
    ["how good his second tight end is", (r: TeamSeason) => r.secondTightEnd],
    ["how good his third receiver is", (r: TeamSeason) => r.thirdReceiver],
    ["the gap between the two", (r: TeamSeason) => r.secondTightEnd - r.thirdReceiver],
  ] as [string, (r: TeamSeason) => number][]) {
    console.log(
      "  " + label.padEnd(36) +
      spearman(rows.map(get), rows.map((r) => r.twelve)).toFixed(3).padStart(9),
    );
  }

  // and the question that started this: what carries into next season
  const byKey = new Map(rows.map((r) => [`${r.team}|${r.season}`, r]));
  const pairs: { before: TeamSeason; after: TeamSeason }[] = [];

  for (const row of rows) {
    const before = byKey.get(`${row.team}|${row.season - 1}`);
    if (before) pairs.push({ before, after: row });
  }

  const kept = pairs.filter((p) => p.before.oc && p.before.oc === p.after.oc);
  const changed = pairs.filter((p) => !p.before.oc || p.before.oc !== p.after.oc);

  console.log(`\nwhat comes back next season, ${kept.length} kept the caller, ${changed.length} did not\n`);
  console.log("  predicting next year's two tight end rate     kept     changed");

  for (const [label, get] of [
    ["last year's rate", (p: { before: TeamSeason }) => p.before.twelve],
    ["last year's gap in the rooms",
      (p: { before: TeamSeason }) => p.before.secondTightEnd - p.before.thirdReceiver],
    ["this year's gap in the rooms",
      (p: { after: TeamSeason }) => p.after.secondTightEnd - p.after.thirdReceiver],
  ] as [string, (p: { before: TeamSeason; after: TeamSeason }) => number][]) {
    const score = (list: typeof pairs) =>
      list.length >= 12
        ? spearman(list.map(get), list.map((p) => p.after.twelve)).toFixed(3).padStart(9)
        : "too few".padStart(9);
    console.log("  " + label.padEnd(42) + score(kept) + score(changed));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
