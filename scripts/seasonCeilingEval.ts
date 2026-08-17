/**
 * What is holding the draft board back: usage or efficiency?
 *
 * The board ranks a season at about .79. Rather than guess where the
 * missing fifth is, each of these is handed the answer to one half of
 * the problem and made to guess the other. Whichever half helps more is
 * where the work is worth doing.
 *
 * A man's points are how often he touches it times what he does with
 * it, so those are the two halves.
 *
 * Run: npx tsx scripts/seasonCeilingEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { spearman } from "../src/backtest/metrics.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { loadAdp } from "../src/data/adp.js";
import { normalizeName } from "../src/data/names.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";

const RULES = presets.standard;
const SCORE_ON = 2025;

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

interface Season {
  playerId: string;
  position: string;
  team: string;
  games: number;
  touches: number;
  points: number;
  /** his cut of his offence's plays */
  share: number;
  /** points he made per touch */
  perTouch: number;
}

async function seasonOf(season: number): Promise<Map<string, Season>> {
  const teamPlays = new Map<string, number>();

  for (const row of parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "plays.csv"), "utf8",
  ))) {
    if (Number(row["season"]) !== season) continue;
    if (!["run", "pass"].includes(row["playType"] ?? "")) continue;
    teamPlays.set(row["offense"] ?? "", (teamPlays.get(row["offense"] ?? "") ?? 0) + 1);
  }

  const tally = new Map<string, Season>();

  for (const s of await loadPlayerStats(season)) {
    if (s.week > 18 || !["RB", "WR", "TE"].includes(s.position)) continue;
    const own = tally.get(s.playerId) ?? {
      playerId: s.playerId, position: s.position, team: s.teamId,
      games: 0, touches: 0, points: 0, share: 0, perTouch: 0,
    };
    own.games++;
    own.team = s.teamId;
    own.touches += s.carries + s.targets;
    own.points += fantasyPoints(s.statLine, RULES);
    tally.set(s.playerId, own);
  }

  for (const own of tally.values()) {
    const plays = teamPlays.get(own.team) ?? 1000;
    own.share = own.touches / plays;
    own.perTouch = own.points / Math.max(1, own.touches);
  }

  return tally;
}

async function main(): Promise<void> {
  const names = new Map<string, string>();

  for (const s of await loadPlayerStats(SCORE_ON)) {
    names.set(s.playerId, s.playerName);
  }

  const before = await seasonOf(SCORE_ON - 1);
  const now = await seasonOf(SCORE_ON);
  const both = [...now.values()].filter((man) => {
    const was = before.get(man.playerId);
    return was && was.games >= 8 && man.games >= 8 && was.touches >= 40;
  });

  console.log(`${both.length} men who played both seasons\n`);

  const leaguePerTouch = middle([...now.values()].map((m) => m.perTouch));
  const truth = both.map((m) => m.points);

  /**
   * Each guess is his touches times his points per touch, with one or
   * both taken from the season being guessed at. Anything using this
   * season is cheating and is here as a ceiling.
   */
  const ways: [string, (man: Season) => number][] = [
    ["last season's points", (man) => before.get(man.playerId)!.points],
    ["last season's touches and rate", (man) => {
      const was = before.get(man.playerId)!;
      return was.touches * was.perTouch;
    }],
    ["knowing this season's touches", (man) => {
      const was = before.get(man.playerId)!;
      return man.touches * was.perTouch;
    }],
    ["knowing this season's rate", (man) => {
      const was = before.get(man.playerId)!;
      return was.touches * man.perTouch;
    }],
    ["knowing his touches, at league rate", (man) => man.touches * leaguePerTouch],
    ["knowing both", (man) => man.touches * man.perTouch],
  ];

  console.log("ranking a season of points   spearman");

  for (const [label, say] of ways) {
    console.log(
      "  " + label.padEnd(36) + spearman(both.map(say), truth).toFixed(4).padStart(7),
    );
  }

  // Can the volume half be done better than repeating last season?
  // When a team loses players their work has to go somewhere, so the
  // men still there should be expected to do more of it.
  const playsNow = new Map<string, number>();

  for (const row of parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "plays.csv"), "utf8",
  ))) {
    if (Number(row["season"]) !== SCORE_ON) continue;
    if (!["run", "pass"].includes(row["playType"] ?? "")) continue;
    playsNow.set(row["offense"] ?? "", (playsNow.get(row["offense"] ?? "") ?? 0) + 1);
  }

  // who is still on each offence, and how much of last year's work the
  // survivors between them used to do
  const stayed = new Map<string, number>();

  for (const man of now.values()) {
    const was = before.get(man.playerId);

    if (!was || was.games < 4) {
      continue;
    }

    stayed.set(man.team, (stayed.get(man.team) ?? 0) + was.share);
  }

  const guessTouches: [string, (man: Season) => number][] = [
    ["last season's touches", (man) => before.get(man.playerId)!.touches],
    ["his old share of this season's plays", (man) =>
      before.get(man.playerId)!.share * (playsNow.get(man.team) ?? 1000)],
    ["shared out among who is left", (man) => {
      const left = stayed.get(man.team) ?? 1;
      return before.get(man.playerId)!.share / Math.max(0.2, left) *
        (playsNow.get(man.team) ?? 1000);
    }],
  ];

  console.log("\nguessing how often he touches it this season   spearman");

  for (const [label, say] of guessTouches) {
    console.log(
      "  " + label.padEnd(40) +
      spearman(both.map(say), both.map((m) => m.touches)).toFixed(4).padStart(7),
    );
  }

  console.log("\nand what that does to the points   spearman");

  for (const [label, say] of guessTouches) {
    console.log(
      "  " + label.padEnd(40) +
      spearman(both.map((m) => say(m) * leaguePerTouch), truth).toFixed(4).padStart(7),
    );
  }

  // Sharing the work out among the men still there made things worse,
  // so where does it go? Anyone on an offence this season who was not
  // on it last season is a newcomer, rookie or otherwise.
  const wasOn = new Map<string, string>();

  for (const man of before.values()) {
    wasOn.set(man.playerId, man.team);
  }

  const newcomers = new Map<string, number>();
  const returners = new Map<string, number>();

  for (const man of now.values()) {
    const side = wasOn.get(man.playerId) === man.team ? returners : newcomers;
    side.set(man.team, (side.get(man.team) ?? 0) + man.share);
  }

  const teams = [...new Set([...newcomers.keys(), ...returners.keys()])];
  const newShare = teams.map((team) => {
    const fresh = newcomers.get(team) ?? 0;
    const old = returners.get(team) ?? 0;
    return fresh / Math.max(0.001, fresh + old);
  }).sort((a, b) => a - b);

  console.log(
    "\nof the work an offence gives out, how much goes to men who were" +
    "\nnot on it last season" +
    `\n  middling team ${(100 * newShare[Math.floor(newShare.length / 2)]!).toFixed(0)}%` +
    `, lowest ${(100 * newShare[0]!).toFixed(0)}%` +
    `, highest ${(100 * newShare[newShare.length - 1]!).toFixed(0)}%`,
  );

  // The room reads the papers, so it knows who signed where and who
  // was drafted. Does that beat last season's usage at saying how often
  // a man will touch it?
  const adp = await loadAdp(SCORE_ON, "ppr").catch(() => new Map());
  const priced = both.map((man) => {
    const nameOf = names.get(man.playerId) ?? "";
    const entry = adp.get(`${normalizeName(nameOf)}|${man.position}`);
    return { man, adp: entry ? entry.adp : null };
  }).filter((row) => row.adp !== null);

  // Only men who played both seasons get this far, which is the ground
  // history is strongest on and leaves out the rookies and the movers
  // the room is there to price. Read it as a floor for the room.
  if (priced.length) {
    console.log(
      `\nagainst the room, on ${priced.length} men it had a price for   spearman` +
      "\n  last season's touches                  " +
      spearman(
        priced.map((r) => before.get(r.man.playerId)!.touches),
        priced.map((r) => r.man.touches),
      ).toFixed(4) +
      "\n  where the room drafted him              " +
      spearman(priced.map((r) => -r.adp!), priced.map((r) => r.man.touches)).toFixed(4) +
      "\n  and for the points he scored" +
      "\n  last season's touches                  " +
      spearman(
        priced.map((r) => before.get(r.man.playerId)!.touches),
        priced.map((r) => r.man.points),
      ).toFixed(4) +
      "\n  where the room drafted him              " +
      spearman(priced.map((r) => -r.adp!), priced.map((r) => r.man.points)).toFixed(4),
    );
  }

  // how well each half of the problem carries from one season to the next
  const carry = (of: (man: Season) => number) =>
    spearman(both.map((m) => of(before.get(m.playerId)!)), both.map(of));

  console.log(
    "\nhow much of each half carries from last season" +
    `\n  his share of the plays   ${carry((m) => m.share).toFixed(4)}` +
    `\n  his touches             ${carry((m) => m.touches).toFixed(4)}` +
    `\n  his points per touch    ${carry((m) => m.perTouch).toFixed(4)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
