/**
 * How good the drive walk is, at three levels at once.
 *
 * A drive simulator can look right on drives and still be useless,
 * because the thing anyone drafts on is a player's week. So this asks
 * the same model three questions: do its drives end the way drives
 * end, do its games score what games score, and does a player get what
 * that player got. The situational week model, which never walks a
 * drive, is scored beside it on the third.
 *
 * Run: npx tsx scripts/driveToPlayerEval.ts
 */

import { loadGames, loadPlayerStats } from "../src/data/nflverse.js";
import { fantasyPoints, presets } from "../src/scoring/fantasyPoints.js";
import { rmse, spearman } from "../src/backtest/metrics.js";
import { seededRng } from "../src/sim/rng.js";
import { normalDraw } from "../src/sim/normal.js";
import { fitRoles } from "../src/features/fitRoles.js";
import { fitDriveRules } from "../src/features/driveRules.js";
import { simulateDrive, type Drive, type DriveEnd } from "../src/model/drive.js";
import { attributeDrives } from "../src/model/attribution.js";
import { linesFrom, simulatePlayerDrive } from "../src/model/playerDrive.js";
import { simulateSituationalWeek, forGame } from "../src/model/situationalWeek.js";
import type { Draws } from "../src/model/playerWeek.js";
import type { SituationalRole } from "../src/model/situationalWeek.js";

const RULES = presets.standard;
const SCORE_ON = 2025;
const RUNS = 60;
/** what a team gets in a game, from the play-by-play */
const DRIVES_A_GAME = 11;

const POINTS: Partial<Record<DriveEnd, number>> = {
  touchdown: 7, fieldGoal: 3,
};

/** the man most likely to be throwing, since the passing goes to him */
function passerOf(roster: SituationalRole[]): string {
  const quarterbacks = roster.filter((p) => p.position === "QB");

  if (!quarterbacks.length) {
    return "";
  }

  return quarterbacks.reduce((best, p) =>
    p.targetShare.openField + p.carryShare.openField >
    best.targetShare.openField + best.carryShare.openField ? p : best,
  ).playerId;
}

function aGameOfDrives(
  rules: Awaited<ReturnType<typeof fitDriveRules>>,
  draws: Draws,
  count: number,
): Drive[] {
  const drives: Drive[] = [];

  for (let i = 0; i < count; i++) {
    // where drives really start, measured at a median of 75 and a
    // spread of 13 rather than picked to look reasonable
    const startAt = Math.max(
      35, Math.min(99, Math.round(75 + draws.normal() * 13)),
    );
    // No form multiplier. Drawing one per drive was meant to bring the
    // short drives into line, and it does the opposite: it stretches
    // both tails, taking three and outs from 32.8% to 36.7% against a
    // real 33.9%.
    drives.push(simulateDrive(startAt, rules, draws.uniform));
  }

  return drives;
}

/** one run of the whole thing, from a given start */
async function onePass(seed: number, report: boolean) {
  const positions = new Map<string, string>();
  const played = new Map<string, number>();

  for (const s of await loadPlayerStats(SCORE_ON - 1)) {
    positions.set(s.playerId, s.position);
    played.set(s.playerId, (played.get(s.playerId) ?? 0) + 1);
  }

  const { byTeam, playsByTeam } = await fitRoles(SCORE_ON - 1, positions, played);
  const rules = await fitDriveRules([2022, 2023, 2024]);
  if (report) {
    console.log(`rules from ${rules.plays} plays, roles from ${SCORE_ON - 1}\n`);
  }

  const rng = seededRng(seed);
  const draws: Draws = { uniform: rng, normal: () => normalDraw(rng) };

  // ---- drives ----
  const endings = new Map<DriveEnd, number>();
  const lengths: number[] = [];
  const simulatedPoints: number[] = [];

  for (let game = 0; game < 4000; game++) {
    const drives = aGameOfDrives(rules, draws, DRIVES_A_GAME);
    let points = 0;

    for (const drive of drives) {
      endings.set(drive.ending, (endings.get(drive.ending) ?? 0) + 1);
      lengths.push(drive.plays.length);
      points += POINTS[drive.ending] ?? 0;
    }

    simulatedPoints.push(points);
  }

  const drivesSeen = lengths.length;
  const share = (end: DriveEnd) => (endings.get(end) ?? 0) / drivesSeen;
  const middle = (values: number[]) =>
    values.reduce((a, b) => a + b, 0) / values.length;

  if (report) {
  console.log("drives                simulated   really");
  console.log(
    "  plays a drive         " + middle(lengths).toFixed(1).padStart(8) +
    "      5.9",
  );
  console.log(
    "  three or fewer        " +
    (100 * lengths.filter((n) => n <= 3).length / drivesSeen).toFixed(1)
      .padStart(7) + "%    33.9%",
  );
  console.log(
    "  ends in a touchdown   " + (100 * share("touchdown")).toFixed(1)
      .padStart(7) + "%    23.6%",
  );
  console.log(
    "  ends in a kick        " + (100 * share("fieldGoal")).toFixed(1)
      .padStart(7) + "%    14.0%",
  );

  // ---- games ----
  const scored: number[] = [];

  for (const game of await loadGames()) {
    if (game.season !== SCORE_ON || game.week > 18) {
      continue;
    }

    if (game.homeScore !== undefined) scored.push(game.homeScore);
    if (game.awayScore !== undefined) scored.push(game.awayScore);
  }

  const spread = (values: number[]) => {
    const mid = middle(values);
    return Math.sqrt(middle(values.map((v) => (v - mid) ** 2)));
  };

  console.log("\ngames                 simulated   really");
  console.log(
    "  points a team         " + middle(simulatedPoints).toFixed(1).padStart(8) +
    middle(scored).toFixed(1).padStart(9),
  );
  console.log(
    "  spread of that        " + spread(simulatedPoints).toFixed(1).padStart(8) +
    spread(scored).toFixed(1).padStart(9),
  );
  }

  // ---- players ----
  const actual = new Map<string, number[]>();

  for (const s of await loadPlayerStats(SCORE_ON)) {
    if (s.week > 18) {
      continue;
    }

    const weeks = actual.get(s.playerId) ?? [];
    weeks.push(fantasyPoints(s.statLine, RULES));
    actual.set(s.playerId, weeks);
  }

  const fromDrives = new Map<string, number[]>();
  const fromSituations = new Map<string, number[]>();
  const fromPlayers = new Map<string, number[]>();
  const playerEndings = new Map<string, number>();
  const playerLengths: number[] = [];
  const playerPoints: number[] = [];

  for (const [team, roster] of byTeam) {
    const plays = playsByTeam.get(team);

    if (!plays) {
      continue;
    }

    const quarterback = passerOf(roster);

    for (let run = 0; run < RUNS; run++) {
      const drives = aGameOfDrives(rules, draws, DRIVES_A_GAME);

      for (const line of attributeDrives(drives, roster, draws, { quarterback })) {
        const weeks = fromDrives.get(line.playerId) ?? [];
        weeks.push(fantasyPoints(line, RULES));
        fromDrives.set(line.playerId, weeks);
      }

      // the same game, with the players making the plays rather than
      // being handed yards the drive already chose
      const available = roster.map((p) => draws.uniform() < p.availability);
      const walked = Array.from({ length: DRIVES_A_GAME }, () =>
        simulatePlayerDrive(
          Math.max(35, Math.min(99, Math.round(75 + draws.normal() * 13))),
          roster, available, rules, draws,
        ));
      let points = 0;

      for (const drive of walked) {
        playerEndings.set(drive.ending, (playerEndings.get(drive.ending) ?? 0) + 1);
        playerLengths.push(drive.plays.length);
        points += drive.ending === "touchdown" ? 7 : drive.ending === "fieldGoal" ? 3 : 0;
      }

      playerPoints.push(points);

      for (const line of linesFrom(walked, roster, available, quarterback)) {
        const weeks = fromPlayers.get(line.playerId) ?? [];
        weeks.push(fantasyPoints(line, RULES));
        fromPlayers.set(line.playerId, weeks);
      }

      const week = simulateSituationalWeek(
        forGame({ plays }, { favouredBy: 0, total: 45, wind: 0, opponent: 1 }),
        roster, draws,
      );

      for (const line of week) {
        const weeks = fromSituations.get(line.playerId) ?? [];
        weeks.push(fantasyPoints(line, RULES));
        fromSituations.set(line.playerId, weeks);
      }
    }
  }

  if (report) {
    const seen = playerLengths.length;
    console.log("\ndrives made of players    simulated   really");
    console.log(
      "  plays a drive           " + middle(playerLengths).toFixed(1).padStart(8) +
      "      5.9",
    );
    console.log(
      "  three or fewer          " +
      (100 * playerLengths.filter((n) => n <= 3).length / seen).toFixed(1)
        .padStart(7) + "%    33.9%",
    );
    console.log(
      "  ends in a touchdown     " +
      (100 * (playerEndings.get("touchdown") ?? 0) / seen).toFixed(1)
        .padStart(7) + "%    23.6%",
    );
    console.log(
      "  points a team           " + middle(playerPoints).toFixed(1).padStart(8) +
      "     23.0",
    );
  }

  const rows: { real: number; drive: number; situation: number; players: number }[] = [];

  for (const [playerId, weeks] of actual) {
    const drive = fromDrives.get(playerId);
    const situation = fromSituations.get(playerId);
    const players = fromPlayers.get(playerId);

    if (!drive || !situation || !players || weeks.length < 8) {
      continue;
    }

    rows.push({
      real: middle(weeks), drive: middle(drive),
      situation: middle(situation), players: middle(players),
    });
  }

  return rows;
}

const middleOf = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

async function main(): Promise<void> {
  const seeds = [11, 12, 13, 14, 15];
  const runs = [];

  for (const seed of seeds) {
    runs.push(await onePass(seed, seed === seeds[0]));
  }

  const rows = runs[0]!;
  console.log(`\nplayers, ${rows.length} of them with eight weeks or more`);
  console.log("  model                 rmse                        rank");

  for (const [label, of] of [
    ["walked drives", (r: { drive: number }) => r.drive],
    ["situational week", (r: { situation: number }) => r.situation],
    ["players making plays", (r: { players: number }) => r.players],
  ] as [string, (r: any) => number][]) {
    const errors = runs.map((run) => rmse(run.map(of), run.map((r) => r.real)));
    const ranks = runs.map((run) => spearman(run.map(of), run.map((r) => r.real)));
    const show = (values: number[]) => {
      const mid = middleOf(values);
      const sd = Math.sqrt(middleOf(values.map((v) => (v - mid) ** 2)));
      return `${mid.toFixed(3)} give or take ${sd.toFixed(3)}`;
    };
    console.log("  " + label.padEnd(20) + show(errors).padEnd(28) + show(ranks));
  }

  console.log(
    "\n  they really average " + middleOf(rows.map((r) => r.real)).toFixed(2) +
    " a game, walked drives say " + middleOf(rows.map((r) => r.drive)).toFixed(2) +
    ", the situational week " + middleOf(rows.map((r) => r.situation)).toFixed(2) +
    " and players making plays " + middleOf(rows.map((r) => r.players)).toFixed(2),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
