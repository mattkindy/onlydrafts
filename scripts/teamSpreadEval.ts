/**
 * Does the walk tell one offence from another?
 *
 * Its drives look right on average and its games rank badly, which
 * would happen if every team came out near the league. A simulation can
 * reproduce the league's drive shape perfectly and still put all
 * thirty two offences within a point of each other, and then no
 * ordering of games is possible.
 *
 * So compare the spread of what it says about teams with the spread of
 * what teams actually do.
 *
 * Run: npx tsx scripts/teamSpreadEval.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "../src/data/csv.js";
import { spearman } from "../src/backtest/metrics.js";
import { seededRng } from "../src/sim/rng.js";
import { normalDraw } from "../src/sim/normal.js";
import { loadPlayerStats } from "../src/data/nflverse.js";
import { fitRoles } from "../src/features/fitRoles.js";
import { fitDriveRules, fitTeamDriveRules } from "../src/features/driveRules.js";
import { simulatePlayerDrive } from "../src/model/playerDrive.js";
import type { Draws } from "../src/model/playerWeek.js";

const SCORE_ON = 2025;
const LEARN_FROM = [2022, 2023, 2024];
const DRIVES_A_GAME = 11;
const GAMES = 400;

const middle = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

const spreadOf = (values: number[]) => {
  const mid = middle(values);
  return Math.sqrt(middle(values.map((v) => (v - mid) ** 2)));
};

async function main(): Promise<void> {
  const positions = new Map<string, string>();
  const played = new Map<string, number>();

  for (const s of await loadPlayerStats(SCORE_ON - 1)) {
    positions.set(s.playerId, s.position);
    played.set(s.playerId, (played.get(s.playerId) ?? 0) + 1);
  }

  const { byTeam } = await fitRoles(SCORE_ON - 1, positions, played);
  // and last season's roles with the same pull eased off, which is the
  // version that could actually be used
  const { byTeam: lastLoose } = await fitRoles(
    SCORE_ON - 1, positions, played, 17, { usage: 4, scoring: 1 },
  );

  // The same walk given the roles the season turned out to have. This
  // cannot predict anything, since it has seen the answer. It says
  // whether the walk loses a team's quality on its way through, or
  // whether it faithfully passes on inputs describing last year's team.
  const nowPositions = new Map<string, string>();
  const nowPlayed = new Map<string, number>();

  for (const s of await loadPlayerStats(SCORE_ON)) {
    nowPositions.set(s.playerId, s.position);
    nowPlayed.set(s.playerId, (nowPlayed.get(s.playerId) ?? 0) + 1);
  }

  const { byTeam: rolesNow } = await fitRoles(SCORE_ON, nowPositions, nowPlayed);

  // Player rates are pulled hard toward the league, which is right for
  // projecting one man and may be what flattens the teams. Try it with
  // the pull eased off.
  const { byTeam: rolesLoose } = await fitRoles(
    SCORE_ON, nowPositions, nowPlayed, 17, { usage: 4, scoring: 1 },
  );
  const league = await fitDriveRules(LEARN_FROM);
  const { byTeam: teamRules } = await fitTeamDriveRules(LEARN_FROM);

  /**
   * A team built from the men on it, rather than from what the team
   * did last year.
   *
   * Each player keeps his own description from last season, wherever he
   * played it, and the shares of whoever is on this roster now are
   * scaled up to fill the offence between them. A man who left takes
   * his work with him and a man who arrived brings his.
   */
  const nowOn = new Map<string, string>();

  for (const s of await loadPlayerStats(SCORE_ON)) {
    if (s.week <= 18) nowOn.set(s.playerId, s.teamId);
  }

  const fromPlayers = new Map<string, typeof byTeam extends Map<string, infer V> ? V : never>();

  for (const roster of byTeam.values()) {
    for (const player of roster) {
      const team = nowOn.get(player.playerId);

      if (!team) {
        continue;
      }

      fromPlayers.set(team, [...(fromPlayers.get(team) ?? []), player]);
    }
  }

  // the offence has one ball, so whoever is here shares it out between
  // them however much of it they used to take
  for (const [team, roster] of fromPlayers) {
    for (const kind of ["targetShare", "carryShare"] as const) {
      for (const spot of ["openField", "thirdAndShort", "thirdAndLong", "nearGoal"] as const) {
        const total = roster.reduce((a, p) => a + p[kind][spot], 0);

        if (total <= 0.05) {
          continue;
        }

        for (const player of roster) {
          player[kind][spot] = player[kind][spot] / total;
        }
      }
    }

    fromPlayers.set(team, roster);
  }

  const rng = seededRng(17);
  const draws: Draws = { uniform: rng, normal: () => normalDraw(rng) };

  const say = (team: string, ownRules: boolean, roles = byTeam) => {
    const roster = roles.get(team);

    if (!roster) {
      return NaN;
    }

    const rules = ownRules ? teamRules.get(team) ?? league : league;
    let points = 0;

    for (let game = 0; game < GAMES; game++) {
      const available = roster.map((p) => draws.uniform() < p.availability);

      for (let i = 0; i < DRIVES_A_GAME; i++) {
        const drive = simulatePlayerDrive(
          Math.max(35, Math.min(99, Math.round(75 + draws.normal() * 13))),
          roster, available, rules, draws,
        );
        points += drive.ending === "touchdown" ? 7
          : drive.ending === "fieldGoal" ? 3 : 0;
      }
    }

    return points / GAMES;
  };

  // what each offence really scored a game
  const reallyScored = new Map<string, { points: number; games: Set<number> }>();

  for (const row of parseCsv(await readFile(
    join(import.meta.dirname, "..", "data", "curated", "drives.csv"), "utf8",
  ))) {
    if (Number(row["season"]) !== SCORE_ON || Number(row["week"]) > 18) continue;
    const team = row["offense"] ?? "";
    const own = reallyScored.get(team) ?? { points: 0, games: new Set<number>() };
    own.points += Number(row["points"]);
    own.games.add(Number(row["week"]));
    reallyScored.set(team, own);
  }

  const teams = [...byTeam.keys()].filter((team) => reallyScored.has(team));
  const truth = teams.map((team) => {
    const own = reallyScored.get(team)!;
    return own.points / own.games.size;
  });
  const onLeague = teams.map((team) => say(team, false));
  const onOwn = teams.map((team) => say(team, true));
  const onNow = teams.map((team) => say(team, true, rolesNow));
  const onLoose = teams.map((team) => say(team, true, rolesLoose));
  const onLastLoose = teams.map((team) => say(team, true, lastLoose));
  const onRoster = teams.map((team) => say(team, true, fromPlayers));

  console.log(`${teams.length} offences in ${SCORE_ON}\n`);
  console.log("points a game            spread across teams   ranks them");
  console.log(
    "  what they really did   " + spreadOf(truth).toFixed(2).padStart(10),
  );
  console.log(
    "  walked, league rules   " + spreadOf(onLeague).toFixed(2).padStart(10) +
    spearman(onLeague, truth).toFixed(3).padStart(14),
  );
  console.log(
    "  walked, their own      " + spreadOf(onOwn).toFixed(2).padStart(10) +
    spearman(onOwn, truth).toFixed(3).padStart(14),
  );
  console.log(
    "  built from who is on   " + spreadOf(onRoster).toFixed(2).padStart(10) +
    spearman(onRoster, truth).toFixed(3).padStart(14),
  );
  console.log("  the team now");
  console.log(
    "  last season, pulled    " + spreadOf(onLastLoose).toFixed(2).padStart(10) +
    spearman(onLastLoose, truth).toFixed(3).padStart(14),
  );
  console.log("  less");
  console.log(
    "  walked, roles as they  " + spreadOf(onNow).toFixed(2).padStart(10) +
    spearman(onNow, truth).toFixed(3).padStart(14),
  );
  console.log("  turned out (cheating)");
  console.log(
    "  the same, pulled less  " + spreadOf(onLoose).toFixed(2).padStart(10) +
    spearman(onLoose, truth).toFixed(3).padStart(14),
  );

  const named = teams.map((team, i) => ({
    team, truth: truth[i]!, said: onOwn[i]!,
  })).sort((a, b) => b.truth - a.truth);

  console.log("\n  team    really   walked");

  for (const row of [...named.slice(0, 5), ...named.slice(-5)]) {
    console.log(
      "  " + row.team.padEnd(8) + row.truth.toFixed(1).padStart(5) +
      row.said.toFixed(1).padStart(9),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
